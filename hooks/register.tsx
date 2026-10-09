/**
 * tokensaver's hooks module: the thin layer between Claude Code's events and
 * the pure session controller in ../src. Every hook here observes, routes or
 * draws; none approves a tool call, and there is no `tool.check` hook at all,
 * so the mod cannot override a permission rule. It never starts a sub-agent
 * itself either: delegation is always Claude's own, reviewed, action.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult, TurnUsage } from 'claude-code'

import { isRecord } from '../src/core/log.ts'
import {
  hydrate,
  isAnimating,
  onAgentResult,
  onCommand,
  onDiagnostic,
  onFacts,
  onMeasure,
  onPrompt,
  onSpawn,
  onSpawned,
  onStepUsage,
  onTick,
  onTurnComplete,
} from '../src/runtime/session.ts'
import type { AgentResultInput, Effect, Session, Step, Usage } from '../src/runtime/session.ts'
import { BAND_HEIGHT, bandLine, bandSvg, isBandVisible, routedBadge, spinnerSuffix } from '../src/ui/band.ts'
import { renderDashboard, sparklineLine } from '../src/ui/dashboard.ts'
import { sparklineSvg } from '../src/ui/format.ts'
import { renderStatusLine } from '../src/ui/statusline.ts'
import type { Line, Span, Tone } from '../src/ui/theme.ts'
import { toView } from '../src/ui/view.ts'

const NAME = 'tokensaver'
const TICK_MS = 250
const STORE_LOG = 'log'
const STORE_THRESHOLDS = 'thresholds'
const STORE_SETTINGS = 'settings'
const STORE_DELEGATION = 'delegation'

/** Tools that read the repository; counted to see how much the main loop reads for itself. */
const READING_TOOLS = ['Read', 'Grep', 'Glob']

/** Folders that hold no source of the project's own. */
const SKIPPED_FOLDERS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
  'vendor',
  '.next',
  '.venv',
  '__pycache__',
]
const MAX_LISTINGS = 40
const MAX_COUNTED = 2000

/** About how wide one text cell is in the desktop app, to size a picture to its slot. */
const CELL_PX = 7.4

const revision = atom({ plugin: 'tokensaver', key: 'revision' } as const, 0)

type TextStyle = { color?: Tone; bold?: true; dimColor?: true }

const styleOf = (part: Span): TextStyle => ({
  ...(part.tone === undefined ? {} : { color: part.tone }),
  ...(part.isBold === true ? { bold: true } : {}),
  ...(part.isDim === true ? { dimColor: true } : {}),
})

const usageOf = (usage: TurnUsage): Usage => ({
  model: usage.model,
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})

/** The Agent tool's own token total. A denial, an error and a background launch carry none. */
const totalTokensOf = (result: unknown): number | undefined => {
  const total = isRecord(result) ? result['totalTokens'] : undefined

  return typeof total === 'number' ? total : undefined
}

const resultOf = (toolUseId: string, result: ToolCallResult<'Agent'>): AgentResultInput => ({
  toolUseId,
  isDenied: result.deny !== undefined,
  isError: result.isError === true,
  text: result.text ?? '',
  totalTokens: totalTokensOf(result.result),
  now: Date.now(),
})

/** A call that falls back instead of failing its hook when it is not available. */
const attempt = async <Value,>(call: () => Promise<Value>, fallback: Value): Promise<Value> => {
  try {
    return await call()
  } catch {
    return fallback
  }
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// Module state: a session's worth of bookkeeping. A reload starts it over, and
// `session.start` then rebuilds it from the store.
let session: Session = hydrate({
  options: {},
  storedLog: undefined,
  storedThresholds: undefined,
  storedSettings: undefined,
  noColor: undefined,
}).session
let timer: Timer | undefined
let shownStatus: string | undefined
let isPaneOpen = false
let wasPaneClosedByPerson = false

/** Opens the dashboard pane and keeps what Claude Code answered, for `/tokensaver doctor`. */
const openPane = async ($: EngineInterface, why: string): Promise<void> => {
  try {
    const opened = await $.ui.open({ id: NAME, title: NAME })

    isPaneOpen = opened.isPlaced
    session = onDiagnostic(
      session,
      opened.isPlaced ? `pane opened (${why})` : `pane waiting (${why}): ${opened.reason}`,
    ).session
  } catch (error) {
    isPaneOpen = false
    session = onDiagnostic(session, `pane did not open (${why}): ${reasonOf(error)}`).session
  }
}

const run = async ($: EngineInterface, effect: Effect): Promise<void> => {
  switch (effect.kind) {
    case 'toast':
      $.ui.toast(effect.text)
      break
    case 'log':
      $.ui.log(effect.text)
      break
    case 'save-log':
      await $.store.set(STORE_LOG, session.outcomes)
      await $.store.set(STORE_THRESHOLDS, session.thresholds)
      await $.store.set(STORE_DELEGATION, { minSaving: session.minSaving })
      break
    case 'save-settings':
      await $.store.set(STORE_SETTINGS, session.overrides)
      break
    case 'clear-log':
      await $.store.delete(STORE_LOG)
      await $.store.delete(STORE_THRESHOLDS)
      await $.store.delete(STORE_DELEGATION)
      break
    case 'open-dashboard':
      wasPaneClosedByPerson = false
      await openPane($, 'asked')
      break
    case 'export':
      await $.fs.write(effect.path, effect.json)
      break
  }
}

/** Redraws the status line and everything the mod draws. Display only: nothing here reaches the model. */
const refresh = ($: EngineInterface): void => {
  const status = renderStatusLine(toView(session))

  if (status !== shownStatus) {
    shownStatus = status
    $.ui.status(status)
  }

  void attempt(() => update($, revision, count => count + 1), undefined)

  if (timer === undefined && isAnimating(session)) {
    timer = $.clock.every(TICK_MS, () => {
      session = onTick(session, Date.now()).session

      if (!isAnimating(session)) {
        timer?.cancel()
        timer = undefined
      }

      refresh($)
    })
  }
}

/**
 * Puts the display back in step with the session. What is sent while no
 * surface is attached is dropped, so this runs again whenever one may have
 * appeared: when an app attaches, and at the start of every turn.
 */
const sync = async ($: EngineInterface, why: string): Promise<void> => {
  const surfaces = await attempt(() => $.session.surfaces(), [])

  // Send the status line again even when its text has not changed.
  shownStatus = undefined

  // A surface with room beside the transcript gets the dashboard; the terminal gets the status line.
  if (
    session.config.isEnabled &&
    !isPaneOpen &&
    !wasPaneClosedByPerson &&
    surfaces.some(surface => surface !== 'terminal')
  ) {
    await openPane($, why)
  }

  refresh($)
}

/** Applies a transition: keeps its session, carries out its effects, redraws. */
const commit = async <Reply,>($: EngineInterface, step: Step<Reply>): Promise<Reply> => {
  session = { ...step.session, now: Math.max(step.session.now, Date.now()) }

  for (const effect of step.effects) {
    // A display or storage effect that fails must never fail the hook that caused it.
    await attempt(() => run($, effect), undefined)
  }

  refresh($)

  return step.reply
}

/**
 * Counts the project's files, a few folders deep, to judge how much reading a
 * broad task means. A sample with a ceiling: it reads names only, never contents.
 */
const countFiles = async ($: EngineInterface): Promise<number | undefined> => {
  const queue: { path: string; depth: number }[] = [{ path: '.', depth: 0 }]
  let listings = 0
  let files = 0

  while (queue.length > 0 && listings < MAX_LISTINGS && files < MAX_COUNTED) {
    const folder = queue.shift()

    if (folder === undefined) {
      break
    }

    const entries = await attempt(() => $.fs.list(folder.path), undefined)

    if (entries === undefined) {
      // The first listing failing means the count is unknown, not zero.
      if (listings === 0) {
        return undefined
      }

      continue
    }

    listings += 1

    for (const entry of entries) {
      if (entry.kind === 'file') {
        files += 1
      } else if (entry.kind === 'dir' && folder.depth < 3 && !SKIPPED_FOLDERS.includes(entry.name)) {
        queue.push({
          path: folder.path === '.' ? entry.name : `${folder.path}/${entry.name}`,
          depth: folder.depth + 1,
        })
      }
    }
  }

  return files
}

export const register: Register = (on, options) => {
  session = hydrate({
    options,
    storedLog: undefined,
    storedThresholds: undefined,
    storedSettings: undefined,
    noColor: undefined,
  }).session
  isPaneOpen = false
  wasPaneClosedByPerson = false

  on('session.start', async ($, e, next) => {
    const [storedLog, storedThresholds, storedSettings, storedDelegation, noColor] =
      await Promise.all([
        attempt(() => $.store.get(STORE_LOG), undefined),
        attempt(() => $.store.get(STORE_THRESHOLDS), undefined),
        attempt(() => $.store.get(STORE_SETTINGS), undefined),
        attempt(() => $.store.get(STORE_DELEGATION), undefined),
        attempt(() => $.env.get('NO_COLOR'), undefined),
      ])

    await commit(
      $,
      hydrate({ options, storedLog, storedThresholds, storedSettings, storedDelegation, noColor }),
    )
    await attempt(
      () =>
        $.command.register({
          name: 'tokensaver',
          description: 'Token-saving delegation: status, on/off, dry-run, dashboard, doctor, export, reset',
          argumentHint: '[on|off|dry-run|dashboard|doctor|motion|export|reset|help]',
          immediate: true,
        }),
      undefined,
    )

    const [model, repoFiles] = await Promise.all([
      attempt(() => $.session.model(), undefined),
      countFiles($),
    ])

    await commit($, onFacts(session, { model, repoFiles }))
    await sync($, 'session start')

    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)

    session = onDiagnostic(session, `${e.surface} attached`).session
    await sync($, `${e.surface} attached`)

    return attached
  })

  on('ui.close', { id: 'tokensaver' }, async (_$, e, next) => {
    const closed = await next(e)

    isPaneOpen = false

    // A pane the person closed stays closed until they ask for it again.
    if (e.origin.kind === 'person') {
      wasPaneClosedByPerson = true
    }

    return closed
  }).catch((_$, e, next) => next(e))

  on('command.run', { command: 'tokensaver' }, async ($, e) => {
    const reply = await commit($, onCommand(session, e.args, Date.now()))

    return { text: reply.text }
  })

  // The same commands, declared as files in commands/ so the menu lists them before this
  // module has run: `/tokensaver:doctor` is `/tokensaver doctor`. Answered here, they
  // never reach the model; their file text is only what Claude reads if this hook is absent.
  on(
    'command.run',
    {
      command: [
        'tokensaver:status',
        'tokensaver:dashboard',
        'tokensaver:doctor',
        'tokensaver:on',
        'tokensaver:off',
        'tokensaver:dry-run',
        'tokensaver:help',
      ],
    },
    async ($, e) => {
      const word = e.command.slice('tokensaver:'.length)
      const reply = await commit($, onCommand(session, `${word} ${e.args}`, Date.now()))

      return { text: reply.text }
    },
  ).catch((_$, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const model = await attempt(() => $.session.model(), undefined)

    if (model !== undefined) {
      session = onFacts(session, { model }).session
    }

    await sync($, 'turn start')

    const reply = await commit(
      $,
      onPrompt(session, {
        text: e.text,
        isFromUser: kind === 'composer' || kind === 'bridge' || kind === 'sdk',
        now: Date.now(),
      }),
    )

    return reply.context === undefined
      ? next(e)
      : next({ ...e, context: [...(e.context ?? []), reply.context] })
  }).catch((_$, e, next) => next(e))

  let unnamed = 0

  on('agent.spawn', async ($, e, next) => {
    unnamed += 1

    const toolUseId = e.tool_use_id === '' ? `spawn-${String(unnamed)}` : e.tool_use_id
    const reply = await commit(
      $,
      onSpawn(session, {
        toolUseId,
        prompt: e.prompt,
        description: e.description,
        subagentType: e.subagentType,
        explicitModel: e.model,
        parentModel: e.parentModel,
        parentAgentId: e.parentAgentId,
        isBackground: e.background,
        isPinned: e.fork || e.isTeammate === true || e.workflow !== undefined,
        now: Date.now(),
      }),
    )
    const started = await next(reply.model === undefined ? e : { ...e, model: reply.model })

    await commit(
      $,
      onSpawned(session, {
        toolUseId,
        agentId: started.agentId,
        isDenied: started.deny !== undefined,
        resolvedModel: started.model,
      }),
    )

    return started
  }).catch((_$, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const first = await next(e)
    const reply = await commit($, onAgentResult(session, resultOf(e.tool_use_id, first)))

    // A denied call, a passing result and a dry run all come back with nothing to retry.
    if (reply.retryWith === undefined) {
      return first
    }

    const second = await next({ ...e, model: reply.retryWith })

    await commit($, onAgentResult(session, resultOf(e.tool_use_id, second)))

    return second
  }).catch((_$, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)

    if (result.usage !== null) {
      await commit(
        $,
        onStepUsage(session, {
          turnId: e.turnId,
          agentId: e.agentId,
          usage: usageOf(result.usage),
          reads: result.toolUses.filter(use => READING_TOOLS.includes(use.name)).length,
        }),
      )
    }

    return result
  })

  on('turn.complete', async ($, e, next) => {
    await commit(
      $,
      onTurnComplete(session, {
        turnId: e.turnId,
        agentId: e.agentId,
        usage: e.usage === undefined ? undefined : usageOf(e.usage),
        isFailed: e.reason === 'error' || e.reason === 'refusal',
        isAborted: e.isAborted,
        answer: e.answer,
        now: Date.now(),
      }),
    )

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await commit($, onMeasure(session, { tokens: e.context.tokens, window: e.context.window }))

    return next(e)
  }).catch((_$, e, next) => next(e))

  // --- Drawing ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Reading the revision subscribes the strip to every later change.
    await read($, revision)

    const view = toView(session)

    if (!isBandVisible(view) || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    // Whatever another mod draws in the strip stays, beneath tokensaver's line.
    const beneath = await next(e)

    if (e.surface === 'desktop') {
      const width = Math.round(Math.max(40, e.props.bodyColumns) * CELL_PX)

      return (
        <Box flexDirection="column">
          {h($.ui.resolve({ ...e, surface: 'desktop' as const }).Svg, {
            source: bandSvg(view, width),
            alt: bandLine(view, e.props.bodyColumns)
              .map(part => part.text)
              .join(''),
            width,
            height: BAND_HEIGHT,
          })}
          {beneath}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box>
          {bandLine(view, e.props.bodyColumns).map(part => (
            <Text {...styleOf(part)}>{part.text}</Text>
          ))}
        </Box>
        {beneath}
      </Box>
    )
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    await read($, revision)

    const suffix = spinnerSuffix(toView(session))

    return suffix === undefined
      ? next(e)
      : next({ ...e, props: { ...e.props, suffix: `${e.props.suffix}${suffix}` } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Agent') {
      return next(e)
    }

    // Only a running call is kept in step: its model is decided just after its row appears.
    if (e.props.isRunning) {
      await read($, revision)
    }

    const badge = routedBadge(toView(session), e.props.tool_use_id)
    const row = await next(e)

    if (badge === undefined) {
      return row
    }

    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Box>
          {badge.map(part => (
            <Text {...styleOf(part)}>{part.text}</Text>
          ))}
        </Box>
        {row}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: 'tokensaver' }, async ($, e) => {
    await read($, revision)
    isPaneOpen = true

    const { Box, Text, Button } = $.ui.resolve(e)
    const view = toView(session)
    const columns = e.props.bodyColumns
    const dashboard = renderDashboard(view, columns)
    const row = (line: Line) => (
      <Box>
        {line.map(part => (
          <Text {...styleOf(part)}>{part.text}</Text>
        ))}
      </Box>
    )
    const command = (args: string) => () => commit($, onCommand(session, args, Date.now()))

    return (
      <Box flexDirection="column">
        {dashboard.top.map(row)}
        {e.surface === 'desktop' && view.history.length >= 2 ? (
          <Box>
            <Text>{'Trend    '}</Text>
            {h($.ui.resolve({ ...e, surface: 'desktop' as const }).Svg, {
              source: sparklineSvg(view.history),
              alt: `Estimated savings over the last ${String(view.history.length)} turns`,
            })}
          </Box>
        ) : (
          row(sparklineLine(view, columns))
        )}
        {dashboard.bottom.map(row)}
        <Box gap={2}>
          <Button
            key="power"
            label={view.mode === 'off' ? 'Turn on' : 'Turn off'}
            onPress={command(view.mode === 'off' ? 'on' : 'off')}
          />
          <Button
            key="dry-run"
            label={view.mode === 'dry-run' ? 'Leave dry-run' : 'Dry-run'}
            onPress={command(view.mode === 'dry-run' ? 'dry-run off' : 'dry-run on')}
          />
        </Box>
      </Box>
    )
  })
}
