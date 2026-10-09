/**
 * tokensaver's hooks module: the thin layer between Claude Code's events and
 * the pure session controller in ../src. Every hook here observes or routes;
 * none approves a tool call, and there is no `tool.check` hook at all, so the
 * mod cannot override a permission rule.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult, TurnUsage } from 'claude-code'

import { isRecord } from '../src/core/log.ts'
import {
  hydrate,
  isAnimating,
  onAgentResult,
  onCommand,
  onMeasure,
  onPrompt,
  onSpawn,
  onSpawned,
  onStepUsage,
  onTick,
  onTurnComplete,
} from '../src/runtime/session.ts'
import type { AgentResultInput, Effect, Session, Step, Usage } from '../src/runtime/session.ts'
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

/** A read that falls back instead of failing its hook when a call is not available. */
const attempt = async <Value,>(read_: () => Promise<Value>, fallback: Value): Promise<Value> => {
  try {
    return await read_()
  } catch {
    return fallback
  }
}

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
      break
    case 'save-settings':
      await $.store.set(STORE_SETTINGS, session.overrides)
      break
    case 'clear-log':
      await $.store.delete(STORE_LOG)
      await $.store.delete(STORE_THRESHOLDS)
      break
    case 'open-dashboard':
      await $.ui.open({ id: NAME, title: NAME })
      break
    case 'export':
      await $.fs.write(effect.path, effect.json)
      break
  }
}

/** Redraws the status line and any open pane. Display only: nothing here reaches the model. */
const refresh = ($: EngineInterface): void => {
  const status = renderStatusLine(toView(session))

  if (status !== shownStatus) {
    shownStatus = status
    $.ui.status(status)
  }

  void attempt(() => update($, revision, count => count + 1), undefined)

  if (timer === undefined && isAnimating(session)) {
    timer = $.clock.every(TICK_MS, () => {
      session = onTick(session).session

      if (!isAnimating(session)) {
        timer?.cancel()
        timer = undefined
      }

      refresh($)
    })
  }
}

/** Applies a transition: keeps its session, carries out its effects, redraws. */
const commit = async <Reply,>($: EngineInterface, step: Step<Reply>): Promise<Reply> => {
  session = step.session

  for (const effect of step.effects) {
    // A display or storage effect that fails must never fail the hook that caused it.
    await attempt(() => run($, effect), undefined)
  }

  refresh($)

  return step.reply
}

export const register: Register = (on, options) => {
  session = hydrate({
    options,
    storedLog: undefined,
    storedThresholds: undefined,
    storedSettings: undefined,
    noColor: undefined,
  }).session

  on('session.start', async ($, e, next) => {
    const [storedLog, storedThresholds, storedSettings, noColor] = await Promise.all([
      attempt(() => $.store.get(STORE_LOG), undefined),
      attempt(() => $.store.get(STORE_THRESHOLDS), undefined),
      attempt(() => $.store.get(STORE_SETTINGS), undefined),
      attempt(() => $.env.get('NO_COLOR'), undefined),
    ])

    await commit($, hydrate({ options, storedLog, storedThresholds, storedSettings, noColor }))
    await attempt(
      () =>
        $.command.register({
          name: 'tokensaver',
          description: 'Token-saving delegation: status, on/off, dry-run, dashboard, export, reset',
          argumentHint: '[on|off|dry-run|dashboard|motion|export|reset|help]',
          immediate: true,
        }),
      undefined,
    )

    // The desktop app has room for the dashboard beside the transcript; the CLI gets the status line.
    const surfaces = await attempt(() => $.session.surfaces(), [])

    if (session.config.isEnabled && surfaces.includes('desktop')) {
      void attempt(() => $.ui.open({ id: NAME, title: NAME }), undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'tokensaver' }, async ($, e) => {
    await commit($, onCommand(session, e.args, Date.now()))

    // No `text`: a command's text is a transcript row the model reads. The answer is drawn instead.
    return {}
  })

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
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
      }),
    )
    const started = await next(reply.model === undefined ? e : { ...e, model: reply.model })

    await commit(
      $,
      onSpawned(session, {
        toolUseId,
        agentId: started.agentId,
        isDenied: started.deny !== undefined,
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

  on('ui.render', { component: 'Pane', requestId: NAME }, async ($, e) => {
    // Reading the revision subscribes this pane to every later change.
    await read($, revision)

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
            <Text>{'Savings  '}</Text>
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
