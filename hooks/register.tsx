/**
 * tokensaver's hooks module: the thin layer between Claude Code's events and
 * the pure controllers in ../src. Two of them run side by side:
 *
 * - the assistant (Clawd): trims noisy shell output and pasted logs before
 *   they are stored, watches the context window and the prompt cache, and
 *   compacts when asked (or, opted in, by itself between turns);
 * - the router: picks the cheapest capable model for sub-agents Claude starts,
 *   and retries one tier up when a result fails its checks.
 *
 * None of it approves a tool call (there is no `tool.check` hook), and it
 * never starts a sub-agent itself.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer, ToolCallResult, TurnUsage } from 'claude-code'

import { isRecord } from '../src/core/log.ts'
import {
  createAssistant,
  fillOf,
  hasFlare,
  moodOf,
  noteEvent,
  onCompacted,
  onContext,
  onIdleCheck,
  onMainRequest,
  onPromptText,
  onToolOutput,
  onTurnEnd,
  parseAssistantOptions,
  parseAssistantOverrides,
  requestCompact,
  speechOf,
  withAssistantConfig,
} from '../src/runtime/assistant.ts'
import type { Assistant, AssistantOverrides, AssistantStep } from '../src/runtime/assistant.ts'
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
import { BAND_HEIGHT, bandSvg, isBandVisible, routedBadge, spinnerSuffix } from '../src/ui/band.ts'
import {
  bandLineOf,
  bandSvgOf,
  bubbleRows,
  clawdArt,
  heroSvg,
  tilesSvg,
} from '../src/ui/clawd.ts'
import type { ClawdView } from '../src/ui/clawd.ts'
import { bar, formatTokens, spinner } from '../src/ui/format.ts'
import type { Span, Tone } from '../src/ui/theme.ts'
import { toView } from '../src/ui/view.ts'

const NAME = 'tokensaver'
const TICK_MS = 250
const STORE_LOG = 'log'
const STORE_THRESHOLDS = 'thresholds'
const STORE_SETTINGS = 'settings'
const STORE_DELEGATION = 'delegation'
const STORE_ASSISTANT = 'assistant'
const STORE_LIFETIME = 'lifetime'

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
const MAX_MARKED_ROWS = 200

/** About how wide one text cell is in the desktop app, to size a picture to its slot. */
const CELL_PX = 7.4

const revision = atom({ plugin: 'tokensaver', key: 'revision' } as const, 0)

type TextStyle = { color?: Tone; weight?: 'semibold'; dimColor?: true }

/** A colour prop only where colour is on. */
const tint = (hasColor: boolean, tone: Tone): { color?: Tone } => (hasColor ? { color: tone } : {})

const styleOf = (part: Span): TextStyle => ({
  ...(part.tone === undefined ? {} : { color: part.tone }),
  ...(part.isBold === true ? { weight: 'semibold' as const } : {}),
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

/** A tool_result block's text, whether it came as a string or as text blocks; undefined for anything else. */
const resultText = (block: Record<string, unknown>): string | undefined => {
  const content = block['content']

  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content) || content.length === 0) {
    return undefined
  }

  const texts = content.map(part => (isRecord(part) && part['type'] === 'text' ? part['text'] : undefined))

  return texts.every(text => typeof text === 'string') ? texts.join('\n') : undefined
}

type Lifetime = { eaten: number; freed: number }

const parseLifetime = (value: unknown): Lifetime => ({
  eaten: isRecord(value) && typeof value['eaten'] === 'number' ? value['eaten'] : 0,
  freed: isRecord(value) && typeof value['freed'] === 'number' ? value['freed'] : 0,
})

// Module state: a session's worth of bookkeeping. A reload starts it over, and
// `session.start` then rebuilds it from the store.
let session: Session = hydrate({
  options: {},
  storedLog: undefined,
  storedThresholds: undefined,
  storedSettings: undefined,
  noColor: undefined,
}).session
let assistant: Assistant = createAssistant(parseAssistantOptions({}))
let assistantOverrides: AssistantOverrides = {}
let lifetime: Lifetime = { eaten: 0, freed: 0 }
let timer: Timer | undefined
let idleTimer: Timer | undefined
let shownStatus: string | undefined
let isPaneOpen = false
let wasPaneClosedByPerson = false
/** Shell rows Clawd trimmed, by tool_use_id, for their badge in the transcript. */
let markedRows = new Map<string, number>()
/** The command each shell call ran, by tool_use_id, so the trimmer knows a search from a build. */
let commands = new Map<string, string>()

const clawdView = (now = Date.now()): ClawdView => {
  const view = toView(session)
  const state = { now, isEnabled: session.config.isEnabled, activeAgents: view.activeCount }

  return {
    mood: moodOf(assistant, state),
    speech: speechOf(assistant, state),
    mode: view.mode,
    hasMotion: !session.config.hasReducedMotion,
    hasColor: !session.hasNoColor,
    context: { ...assistant.context, percent: fillOf(assistant) },
    ghost: assistant.live,
    stats: {
      eaten: assistant.trimmed + assistant.pasteTrimmed,
      reReads: assistant.reReads,
      compactFreed: assistant.compactFreed,
      routed: Math.max(0, session.saved),
      keptOut: session.keptOut,
      trims: assistant.trims + assistant.pastes,
      compactions: assistant.compactions,
    },
    feed: assistant.feed,
    activeAgents: view.activeCount,
    frame: session.frame,
  }
}

/** The status line: one glance at what Clawd is doing for the session. Plain text, no colour codes. */
const statusText = (): string | undefined => {
  if (!session.config.isEnabled || !session.config.hasStatusLine) {
    return undefined
  }

  const view = clawdView()
  const routing = toView(session)
  const glyph = view.activeAgents > 0 ? spinner(session.frame, view.hasMotion) : '●'
  const parts = [
    `${glyph} ${session.config.isDryRun ? 'tokensaver [dry-run]' : 'tokensaver'} ${formatTokens(routing.total)} tok`,
    `Clawd ate ${formatTokens(view.stats.eaten)}`,
    `~${formatTokens(view.stats.reReads)} re-sends avoided`,
  ]

  if (view.context.window > 0) {
    parts.push(`ctx ${bar(view.context.percent / 100, 6)} ${String(view.context.percent)}%`)
  }

  if (view.mood === 'sleepy') {
    parts.push('cache cold: /tokensaver compact')
  }

  if (view.activeAgents > 0) {
    parts.push(`${String(view.activeAgents)} helper${view.activeAgents === 1 ? '' : 's'}`)
  }

  return parts.join(' · ')
}

/** Opens the pane and keeps what Claude Code answered, for `/tokensaver doctor`. */
const openPane = async ($: EngineInterface, why: string): Promise<void> => {
  try {
    const opened = await $.ui.open({ id: NAME, title: 'Clawd · tokensaver' })

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

const saveLifetime = ($: EngineInterface): Promise<void> =>
  attempt(() => $.store.set(STORE_LIFETIME, lifetime), undefined)

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

/** True while something on screen moves or must be taken down on time. */
const needsClock = (): boolean =>
  isAnimating(session) || (session.config.isEnabled && hasFlare(assistant, Date.now()))

/** Redraws the status line and everything the mod draws. Display only: nothing here reaches the model. */
const refresh = ($: EngineInterface): void => {
  const status = statusText()

  if (status !== shownStatus) {
    shownStatus = status
    $.ui.status(status)
  }

  void attempt(() => update($, revision, count => count + 1), undefined)

  if (timer === undefined && needsClock()) {
    timer = $.clock.every(TICK_MS, () => {
      session = onTick(session, Date.now()).session

      if (!needsClock()) {
        timer?.cancel()
        timer = undefined
        // One last frame without the passing mood.
        void attempt(() => update($, revision, count => count + 1), undefined)
        return
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

  // A surface with room beside the transcript gets the pane; the terminal gets the status line and strip.
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

/** Applies a router transition: keeps its session, carries out its effects, redraws. */
const commit = async <Reply,>($: EngineInterface, step: Step<Reply>): Promise<Reply> => {
  const before = session.notes
  session = { ...step.session, now: Math.max(step.session.now, Date.now()) }

  // What the router did shows in Clawd's feed too.
  for (const note of session.notes.filter(note => !before.includes(note))) {
    assistant = noteEvent(assistant, {
      kind: note.includes('escalated') || note.includes('failed') ? 'escalate' : note.includes('→') ? 'route' : 'info',
      text: note,
      now: Date.now(),
    })
  }

  for (const effect of step.effects) {
    // A display or storage effect that fails must never fail the hook that caused it.
    await attempt(() => run($, effect), undefined)
  }

  refresh($)

  return step.reply
}

/** Runs a compaction for Clawd and books what it freed. */
const compactNow = async ($: EngineInterface, instructions: string): Promise<string> => {
  try {
    const result = await $.session.compact({ instructions })

    assistant = onCompacted(assistant, {
      before: result.skip === undefined ? result.tokensBefore : undefined,
      after: result.skip === undefined ? result.tokensAfter : undefined,
      isSkipped: result.skip !== undefined,
      now: Date.now(),
    })

    return result.skip === undefined ? 'Compacted.' : `Compaction skipped: ${result.skip}`
  } catch (error) {
    assistant = { ...assistant, isCompacting: false }

    const text = `Clawd could not compact now: ${reasonOf(error)}`

    $.ui.toast(text)

    return text
  } finally {
    refresh($)
  }
}

/** Applies an assistant transition: keeps it, carries out its effects, redraws. */
const commitAssistant = async <Reply,>($: EngineInterface, step: AssistantStep<Reply>): Promise<Reply> => {
  assistant = step.assistant

  for (const effect of step.effects) {
    if (effect.kind === 'toast') {
      $.ui.toast(effect.text)
    } else if (effect.kind === 'compact') {
      // Never awaited by the hook that noticed the need: it compacts once the turn has let go.
      void compactNow($, effect.instructions)
    } else {
      await attempt(() => $.store.set(STORE_ASSISTANT, assistantOverrides), undefined)
    }
  }

  refresh($)

  return step.reply
}

const applyAssistantOverrides = (options: Readonly<Record<string, unknown>>): void => {
  assistant = withAssistantConfig(assistant, { ...parseAssistantOptions(options), ...assistantOverrides })
}

/** Watches the idle session so Clawd can say when the prompt cache has expired. */
const armIdleCheck = ($: EngineInterface): void => {
  idleTimer?.cancel()
  idleTimer = undefined

  const ttl = assistant.config.cacheTtlMinutes * 60_000

  if (ttl <= 0) {
    return
  }

  const firesAt = Date.now() + ttl + 1000

  idleTimer = $.clock.after(ttl + 1000, () => {
    idleTimer = undefined

    const wasCold = assistant.isCold
    // The timer firing is the proof that the idle time passed, whatever clock drives it.
    assistant = onIdleCheck(assistant, { now: Math.max(Date.now(), firesAt), isEnabled: session.config.isEnabled })

    if (assistant.isCold && !wasCold) {
      $.ui.toast(`Clawd: ${speechOf(assistant, { now: Date.now(), isEnabled: true, activeAgents: 0 })}`)
      refresh($)
    }
  })
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

const ASSISTANT_HELP = [
  '/tokensaver compact      compact now, with focus instructions from your recent asks',
  '/tokensaver trim [on|off]       trim noisy shell output before it is stored',
  '/tokensaver pastes [on|off]     tidy pasted logs in your prompts (lossless)',
  '/tokensaver autocompact <0-95>  compact by itself past this fill % (0 = never)',
].join('\n')

const switchOf = (word: string | undefined, isOn: boolean): boolean =>
  word === 'on' ? true : word === 'off' ? false : !isOn

/** The assistant's own commands; undefined for a word the router answers. */
const assistantCommand = async ($: EngineInterface, args: string): Promise<string | undefined> => {
  const [first = '', second] = args.trim().toLowerCase().split(/\s+/)

  switch (first) {
    case 'compact': {
      const step = requestCompact(assistant)

      assistant = step.assistant

      if (step.reply.instructions === undefined) {
        return `Clawd: ${step.reply.why ?? 'not now'}`
      }

      const instructions = step.reply.instructions

      // A command holds its own turn, under which the engine refuses to compact: start once it has let go.
      $.clock.after(50, () => {
        void compactNow($, instructions)
      })

      return 'Clawd is compacting the conversation, keeping your current task in focus.'
    }
    case 'trim': {
      const isTrimming = switchOf(second, assistant.config.isTrimming)

      assistantOverrides = { ...assistantOverrides, isTrimming }
      await commitAssistant($, {
        assistant: withAssistantConfig(assistant, { ...assistant.config, isTrimming }),
        effects: [{ kind: 'save-assistant' }],
        reply: undefined,
      })

      return `Clawd: output trimming is ${isTrimming ? 'on' : 'off'}`
    }
    case 'pastes': {
      const isTrimmingPastes = switchOf(second, assistant.config.isTrimmingPastes)

      assistantOverrides = { ...assistantOverrides, isTrimmingPastes }
      await commitAssistant($, {
        assistant: withAssistantConfig(assistant, { ...assistant.config, isTrimmingPastes }),
        effects: [{ kind: 'save-assistant' }],
        reply: undefined,
      })

      return `Clawd: paste tidying is ${isTrimmingPastes ? 'on' : 'off'}`
    }
    case 'autocompact': {
      const value = Number(second)

      if (!Number.isFinite(value) || value < 0 || value > 95) {
        return 'Clawd: give a fill percentage from 0 (never) to 95, e.g. /tokensaver autocompact 80'
      }

      const autoCompactAt = Math.round(value)

      assistantOverrides = { ...assistantOverrides, autoCompactAt }
      await commitAssistant($, {
        assistant: withAssistantConfig(assistant, { ...assistant.config, autoCompactAt }),
        effects: [{ kind: 'save-assistant' }],
        reply: undefined,
      })

      return autoCompactAt === 0
        ? 'Clawd: auto-compact is off; I will only suggest it'
        : `Clawd: I will compact between turns once the context passes ${String(autoCompactAt)}%`
    }
    default:
      return undefined
  }
}

const assistantReport = (): string => {
  const view = clawdView()

  return [
    `Clawd ate ${formatTokens(view.stats.eaten)} tokens of noise this session (${String(view.stats.trims)} trims; ${formatTokens(lifetime.eaten)} all-time)`,
    `~${formatTokens(view.stats.reReads)} tokens not re-sent on later requests; ${formatTokens(view.stats.compactFreed)} freed by ${String(view.stats.compactions)} compaction(s)`,
    `context ${view.context.window > 0 ? `${String(view.context.percent)}% (${formatTokens(view.context.tokens)} of ${formatTokens(view.context.window)})` : 'not measured yet'}`,
    `trim ${assistant.config.isTrimming ? `on (${assistant.config.trimLevel}, cap ${String(assistant.config.maxOutputLines)} lines)` : 'off'} · pastes ${assistant.config.isTrimmingPastes ? 'on' : 'off'} · auto-compact ${assistant.config.autoCompactAt === 0 ? 'off' : `at ${String(assistant.config.autoCompactAt)}%`} · cache coach ${assistant.config.cacheTtlMinutes === 0 ? 'off' : `${String(assistant.config.cacheTtlMinutes)} min`}`,
  ].join('\n')
}

/** Runs `/tokensaver <args>`: the assistant's words first, then the router's. */
const runCommand = async ($: EngineInterface, args: string): Promise<string> => {
  const own = await assistantCommand($, args)

  if (own !== undefined) {
    return own
  }

  const reply = await commit($, onCommand(session, args, Date.now()))
  const word = args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

  if (word === '' || word === 'status') {
    return `${assistantReport()}\n${reply.text}`
  }

  return word === 'help' ? `${ASSISTANT_HELP}\n${reply.text}` : reply.text
}

/** Presses on Clawd's buttons, from the pane or the strip. */
const press = ($: EngineInterface, args: string) => async (): Promise<void> => {
  const text = await runCommand($, args)

  $.ui.toast(text.split('\n')[0] ?? text)
}

export const register: Register = (on, options) => {
  session = hydrate({
    options,
    storedLog: undefined,
    storedThresholds: undefined,
    storedSettings: undefined,
    noColor: undefined,
  }).session
  assistant = createAssistant(parseAssistantOptions(options))
  assistantOverrides = {}
  markedRows = new Map()
  commands = new Map()
  isPaneOpen = false
  wasPaneClosedByPerson = false

  on('session.start', async ($, e, next) => {
    const [storedLog, storedThresholds, storedSettings, storedDelegation, storedAssistant, storedLifetime, noColor] =
      await Promise.all([
        attempt(() => $.store.get(STORE_LOG), undefined),
        attempt(() => $.store.get(STORE_THRESHOLDS), undefined),
        attempt(() => $.store.get(STORE_SETTINGS), undefined),
        attempt(() => $.store.get(STORE_DELEGATION), undefined),
        attempt(() => $.store.get(STORE_ASSISTANT), undefined),
        attempt(() => $.store.get(STORE_LIFETIME), undefined),
        attempt(() => $.env.get('NO_COLOR'), undefined),
      ])

    assistantOverrides = parseAssistantOverrides(storedAssistant)
    lifetime = parseLifetime(storedLifetime)
    applyAssistantOverrides(options)

    await commit(
      $,
      hydrate({ options, storedLog, storedThresholds, storedSettings, storedDelegation, noColor }),
    )
    await attempt(
      () =>
        $.command.register({
          name: 'tokensaver',
          description: 'Clawd, your token saver: status, compact, trim, on/off, dashboard, doctor',
          argumentHint: '[compact|trim|pastes|autocompact|on|off|dry-run|dashboard|doctor|motion|export|reset|help]',
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

  on('command.run', { command: 'tokensaver' }, async ($, e) => ({ text: await runCommand($, e.args) }))

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
        'tokensaver:compact',
        'tokensaver:trim',
      ],
    },
    async ($, e) => ({ text: await runCommand($, `${e.command.slice('tokensaver:'.length)} ${e.args}`) }),
  ).catch((_$, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const kind = e.origin.kind
    const isFromUser = kind === 'composer' || kind === 'bridge' || kind === 'sdk'
    const model = await attempt(() => $.session.model(), undefined)

    if (model !== undefined) {
      session = onFacts(session, { model }).session
    }

    idleTimer?.cancel()
    idleTimer = undefined
    await sync($, 'turn start')

    const tidied = await commitAssistant(
      $,
      onPromptText(assistant, {
        text: e.text,
        // A slash command's line and a hidden prompt take no rewrite of their text.
        isFromUser: isFromUser && e.command === undefined && e.isMeta !== true,
        isEnabled: session.config.isEnabled,
        isDryRun: session.config.isDryRun,
        now: Date.now(),
      }),
    )
    const text = tidied.text ?? e.text
    const reply = await commit($, onPrompt(session, { text, isFromUser, now: Date.now() }))
    const passed = tidied.text === undefined ? e : { ...e, text }

    if (tidied.text !== undefined) {
      lifetime = { ...lifetime, eaten: lifetime.eaten + (e.text.length - text.length) / 4 }
      void saveLifetime($)
    }

    return reply.context === undefined
      ? next(passed)
      : next({ ...passed, context: [...(passed.context ?? []), reply.context] })
  }).catch((_$, e, next) => next(e))

  // The output trimmer: a shell's result is shrunk before it is stored, so the
  // model reads (and every later request re-sends) the tidy form only.
  // Claude's own tool calls arrive as response rows just before their results: note each shell command.
  on('session.append', { door: 'response' }, (_$, e, next) => {
    for (const block of e.message.content) {
      const input = block['input']
      const command = isRecord(input) ? input['command'] : undefined

      if (block.type === 'tool_use' && typeof block['id'] === 'string' && typeof command === 'string') {
        commands.set(block['id'], command)
      }
    }

    if (commands.size > MAX_MARKED_ROWS) {
      commands = new Map([...commands].slice(-MAX_MARKED_ROWS))
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    const tool = e.origin.kind === 'tool' ? e.origin.tool : ''
    let cutTotal = 0
    const content = e.message.content.map(block => {
      if (block.type !== 'tool_result' || block['is_error'] === true) {
        return block
      }

      const text = resultText(block)

      if (text === undefined) {
        return block
      }

      const callId = block['tool_use_id']
      const step = onToolOutput(assistant, {
        tool,
        command: typeof callId === 'string' ? commands.get(callId) : undefined,
        text,
        isEnabled: session.config.isEnabled,
        isDryRun: session.config.isDryRun,
        now: Date.now(),
      })

      assistant = step.assistant

      if (step.reply.text === undefined) {
        return block
      }

      const cut = Math.round((text.length - step.reply.text.length) / 4)
      const id = block['tool_use_id']

      if (typeof id === 'string') {
        markedRows.set(id, cut)

        if (markedRows.size > MAX_MARKED_ROWS) {
          markedRows = new Map([...markedRows].slice(-MAX_MARKED_ROWS))
        }
      }

      cutTotal += cut

      return { ...block, content: step.reply.text }
    })

    if (content.every((block, index) => block === e.message.content[index])) {
      return next(e)
    }

    lifetime = { ...lifetime, eaten: lifetime.eaten + cutTotal }
    void saveLifetime($)
    refresh($)

    return next({ ...e, message: { ...e.message, content } })
  }).catch((_$, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const result = await next(e)

    // The main conversation's own compactions, whoever asked; Clawd's own calls book theirs.
    if (e.agentId === undefined && e.trigger !== 'precompute' && e.trigger !== 'plugin') {
      assistant = onCompacted(assistant, {
        before: result.skip === undefined ? result.tokensBefore : undefined,
        after: result.skip === undefined ? result.tokensAfter : undefined,
        isSkipped: result.skip !== undefined,
        now: Date.now(),
      })

      if (result.skip === undefined) {
        lifetime = { ...lifetime, freed: lifetime.freed + Math.max(0, (result.tokensBefore ?? 0) - (result.tokensAfter ?? 0)) }
        void saveLifetime($)
      }

      refresh($)
    }

    return result
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

    if (e.agentId === undefined) {
      assistant = onMainRequest(assistant)
    }

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
    if (e.agentId === undefined) {
      assistant = onTurnEnd(assistant, Date.now())
      armIdleCheck($)
    }

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
    await commitAssistant(
      $,
      onContext(assistant, {
        tokens: e.context.tokens,
        window: e.context.window,
        isEnabled: session.config.isEnabled,
        now: Date.now(),
      }),
    )

    return next(e)
  }).catch((_$, e, next) => next(e))

  // --- Drawing ---------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Reading the revision subscribes the strip to every later change.
    await read($, revision)

    const view = clawdView()
    const routing = toView(session)
    const hasAgents = isBandVisible(routing) && routing.band.agents.length > 0
    const shouldOffer = view.mood === 'sleepy' || (view.mood === 'worried' && view.context.percent >= 70)
    const isVisible =
      view.mode !== 'off' &&
      (hasFlare(assistant, Date.now()) || shouldOffer || hasAgents || (isBandVisible(routing) && routing.band.flash !== undefined))

    if (!isVisible || e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    // Whatever another mod draws in the strip stays, beneath tokensaver's.
    const beneath = await next(e)
    const buttons = shouldOffer ? (
      <Box gap={1}>
        <Button key="band-compact" variant="primary" label="Compact now" onPress={press($, 'compact')} />
      </Box>
    ) : null

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' as const })
      const width = Math.round(Math.max(40, e.props.bodyColumns) * CELL_PX)

      return (
        <Box flexDirection="column">
          <Box gap={1} alignItems="center">
            <Svg source={bandSvgOf(view, shouldOffer ? width - 130 : width)} alt={view.speech} width={shouldOffer ? width - 130 : width} height={46} />
            {buttons}
          </Box>
          {hasAgents ? (
            <Svg source={bandSvg(routing, width)} alt={`${String(routing.activeCount)} helpers running`} width={width} height={BAND_HEIGHT} />
          ) : null}
          {beneath}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Box>
            {bandLineOf(view, e.props.bodyColumns - (shouldOffer ? 16 : 0)).map(part => (
              <Text {...styleOf(part)}>{part.text}</Text>
            ))}
          </Box>
          {buttons}
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
    // A shell row Clawd trimmed says so, and by how much.
    if (e.props.tool !== 'Agent') {
      const cut = markedRows.get(e.props.tool_use_id)

      if (cut === undefined) {
        return next(e)
      }

      const { Box, Text } = $.ui.resolve(e)
      const row = await next(e)

      return (
        <Box flexDirection="column">
          {row}
          <Text {...tint(!session.hasNoColor, 'success')} dimColor>
            {`  ▐▛█▜▌ Clawd ate ${formatTokens(cut)} tokens of noise from this output`}
          </Text>
        </Box>
      )
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
    const view = clawdView()
    const columns = e.props.bodyColumns
    const isOff = view.mode === 'off'
    const feed = [...view.feed].reverse().slice(0, 6)
    const ago = (at: number): string => {
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))

      return seconds < 60 ? `${String(seconds)}s` : `${String(Math.round(seconds / 60))}m`
    }
    const controls = (
      <Box gap={1} flexWrap="wrap">
        <Button key="compact" variant="primary" label="Compact now" onPress={press($, 'compact')} />
        <Button
          key="trim"
          label={assistant.config.isTrimming ? 'Trimming: on' : 'Trimming: off'}
          onPress={press($, 'trim')}
        />
        <Button
          key="pastes"
          label={assistant.config.isTrimmingPastes ? 'Paste tidy: on' : 'Paste tidy: off'}
          onPress={press($, 'pastes')}
        />
        <Button key="power" label={isOff ? 'Wake Clawd' : 'Turn off'} onPress={press($, isOff ? 'on' : 'off')} />
      </Box>
    )

    if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve({ ...e, surface: 'desktop' as const })
      const width = Math.round(Math.max(44, columns) * CELL_PX)

      return (
        <Box flexDirection="column" gap={1}>
          <Svg source={heroSvg(view, width)} alt={`Clawd: ${view.speech}`} width={width} />
          <Svg
            source={tilesSvg(view, width)}
            alt={`${formatTokens(view.stats.eaten)} tokens eaten, ${formatTokens(view.stats.reReads)} re-sends avoided, ${formatTokens(view.stats.compactFreed)} freed by compacting`}
            width={width}
          />
          {controls}
          <Text weight="semibold">Activity</Text>
          {feed.length === 0 ? (
            <Text dimColor>Nothing yet. Run something noisy (a build, a test suite, an install) and watch me eat.</Text>
          ) : (
            feed.map(item => (
              <Box gap={1}>
                <Text {...tint(view.hasColor, (item.kind === 'warn' ? 'warning' : item.kind === 'escalate' ? 'error' : 'success'))}>
                  {item.kind === 'trim' || item.kind === 'paste' ? '✂' : item.kind === 'compact' ? '⇣' : item.kind === 'cold' ? '❄' : item.kind === 'warn' ? '▲' : '•'}
                </Text>
                <Text>{item.text}</Text>
                <Text dimColor>{ago(item.at)}</Text>
              </Box>
            ))
          )}
          <Text dimColor>
            {`All-time: ${formatTokens(lifetime.eaten)} eaten · ${formatTokens(lifetime.freed)} freed by compacting`}
          </Text>
        </Box>
      )
    }

    const art = clawdArt(view)
    const bubble = bubbleRows(view, columns)
    const meter = view.context.window > 0
      ? `${bar(view.context.percent / 100, Math.max(10, columns - 30))} ${String(view.context.percent)}%  ${formatTokens(view.context.tokens)}/${formatTokens(view.context.window)}`
      : 'context: waiting for the first reply'

    return (
      <Box flexDirection="column">
        {art.map((row, index) => (
          <Box>
            <Text {...tint(view.hasColor, (view.mood === 'off' ? 'inactive' : 'claude'))}>{row}</Text>
            <Text>{`  ${bubble[index] ?? ''}`}</Text>
          </Box>
        ))}
        <Text> </Text>
        <Text weight="semibold">Context</Text>
        <Text {...tint(view.hasColor, (view.context.percent >= 85 ? 'error' : view.context.percent >= 70 ? 'warning' : 'claude'))}>{meter}</Text>
        {view.ghost > 0 ? <Text dimColor>{`without Clawd it would hold ${formatTokens(view.ghost)} more`}</Text> : null}
        <Text> </Text>
        <Text>
          <Text {...tint(view.hasColor, 'success')} weight="semibold">{formatTokens(view.stats.eaten)}</Text>
          <Text dimColor> eaten  </Text>
          <Text {...tint(view.hasColor, 'suggestion')} weight="semibold">{formatTokens(view.stats.reReads)}</Text>
          <Text dimColor> re-sends avoided  </Text>
          <Text {...tint(view.hasColor, 'claude')} weight="semibold">{formatTokens(view.stats.compactFreed)}</Text>
          <Text dimColor> freed  </Text>
          <Text {...tint(view.hasColor, 'warning')} weight="semibold">{formatTokens(view.stats.routed + view.stats.keptOut)}</Text>
          <Text dimColor> routing</Text>
        </Text>
        <Text> </Text>
        {controls}
        <Text> </Text>
        <Text weight="semibold">Activity</Text>
        {feed.length === 0 ? (
          <Text dimColor>Nothing yet.</Text>
        ) : (
          feed.map(item => <Text>{`${item.kind === 'warn' ? '▲' : item.kind === 'cold' ? '❄' : item.kind === 'compact' ? '⇣' : '✂'} ${item.text}  ${ago(item.at)}`}</Text>)
        )}
      </Box>
    )
  })
}
