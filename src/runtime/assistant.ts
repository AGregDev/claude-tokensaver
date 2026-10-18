/**
 * Clawd, the assistant: the savers that act on their own (the output and
 * paste trimmers, the context guardian, the cold-cache coach) and the mood
 * and words the mascot shows for them. Pure transitions, like session.ts:
 * `(assistant, input) -> { assistant, effects, reply }`.
 */
import { formatTokens } from '../ui/format.ts'
import {
  afterCompact,
  coldCost,
  compactInstructions,
  compactSaving,
  isCacheCold,
  levelOf,
  MIN_WORTHWHILE_TOKENS,
  percentOf,
  rankOfLevel,
} from '../core/guardian.ts'
import type { GuardLevel } from '../core/guardian.ts'
import { ACTION_WORDS, isInspecting, looksLikeLog, trimOutput } from '../core/trim.ts'
import type { TrimLevel } from '../core/trim.ts'
import { isRecord } from '../core/log.ts'

export type AssistantConfig = {
  isTrimming: boolean
  trimLevel: TrimLevel
  maxOutputLines: number
  isTrimmingPastes: boolean
  /** Fill percentage at which Clawd compacts between turns by itself; 0 is never. */
  autoCompactAt: number
  /** How long the prompt cache lives, in minutes; 0 turns the cold-cache coach off. */
  cacheTtlMinutes: number
}

export const DEFAULT_ASSISTANT: AssistantConfig = {
  isTrimming: true,
  trimLevel: 'full',
  maxOutputLines: 300,
  isTrimmingPastes: true,
  autoCompactAt: 0,
  cacheTtlMinutes: 5,
}

/** The tools whose output the trimmer may shrink: shells and their background output, never file reads. */
export const TRIMMED_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'BashOutput', 'TaskOutput', 'Monitor']

export type Mood = 'idle' | 'chomp' | 'happy' | 'worried' | 'sleepy' | 'busy' | 'alert' | 'off'

export type FeedKind = 'trim' | 'paste' | 'compact' | 'cold' | 'warn' | 'route' | 'escalate' | 'info'

export type FeedItem = { at: number; kind: FeedKind; text: string; tokens: number }

export type Assistant = {
  config: AssistantConfig
  /** Outputs trimmed, and the tokens cut from them. */
  trims: number
  trimmed: number
  /** Tokens cut since the last compaction: still absent from every request that follows. */
  live: number
  /** Re-sends avoided: `live` summed over every main-loop request since it was cut. */
  reReads: number
  pastes: number
  pasteTrimmed: number
  compactions: number
  /** Tokens compactions took off the context. */
  compactFreed: number
  context: { tokens: number; window: number }
  isTurnRunning: boolean
  lastTurnEndAt: number | undefined
  warnedLevel: GuardLevel
  isCold: boolean
  isCompacting: boolean
  feed: readonly FeedItem[]
  /** A passing mood (chomping, cheering) and when it ends. */
  flare: { mood: Mood; until: number; text: string } | undefined
  prompts: readonly string[]
}

export type AssistantEffect =
  | { kind: 'toast'; text: string }
  | { kind: 'compact'; instructions: string }
  | { kind: 'save-assistant' }

export type AssistantStep<Reply> = {
  assistant: Assistant
  effects: readonly AssistantEffect[]
  reply: Reply
}

const MAX_FEED = 12
const MAX_PROMPTS = 6
const FLARE_MS = 5000

const still = <Reply>(assistant: Assistant, reply: Reply): AssistantStep<Reply> => ({
  assistant,
  effects: [],
  reply,
})

const number = (value: unknown, preset: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : preset

const flag = (value: unknown, isOnByDefault: boolean): boolean => (typeof value === 'boolean' ? value : isOnByDefault)

/** Reads the manifest's options for the savers. */
export const parseAssistantOptions = (options: Readonly<Record<string, unknown>>): AssistantConfig => ({
  isTrimming: flag(options['trimOutput'], DEFAULT_ASSISTANT.isTrimming),
  trimLevel: options['trimLevel'] === 'lossless' ? 'lossless' : 'full',
  maxOutputLines: number(options['maxOutputLines'], DEFAULT_ASSISTANT.maxOutputLines, 40, 5000),
  isTrimmingPastes: flag(options['trimPastes'], DEFAULT_ASSISTANT.isTrimmingPastes),
  autoCompactAt: number(options['autoCompactAt'], DEFAULT_ASSISTANT.autoCompactAt, 0, 95),
  cacheTtlMinutes: number(options['cacheTtlMinutes'], DEFAULT_ASSISTANT.cacheTtlMinutes, 0, 120),
})

export type AssistantOverrides = Partial<Pick<AssistantConfig, 'isTrimming' | 'isTrimmingPastes' | 'autoCompactAt'>>

export const parseAssistantOverrides = (value: unknown): AssistantOverrides => {
  if (!isRecord(value)) {
    return {}
  }

  const { isTrimming, isTrimmingPastes, autoCompactAt } = value

  return {
    ...(typeof isTrimming === 'boolean' ? { isTrimming } : {}),
    ...(typeof isTrimmingPastes === 'boolean' ? { isTrimmingPastes } : {}),
    ...(typeof autoCompactAt === 'number' ? { autoCompactAt: number(autoCompactAt, 0, 0, 95) } : {}),
  }
}

export const createAssistant = (config: AssistantConfig): Assistant => ({
  config,
  trims: 0,
  trimmed: 0,
  live: 0,
  reReads: 0,
  pastes: 0,
  pasteTrimmed: 0,
  compactions: 0,
  compactFreed: 0,
  context: { tokens: 0, window: 0 },
  isTurnRunning: false,
  lastTurnEndAt: undefined,
  warnedLevel: 'calm',
  isCold: false,
  isCompacting: false,
  feed: [],
  flare: undefined,
  prompts: [],
})

const withFeed = (assistant: Assistant, item: FeedItem): Assistant => ({
  ...assistant,
  feed: [...assistant.feed, item].slice(-MAX_FEED),
})

const withFlare = (assistant: Assistant, mood: Mood, text: string, now: number): Assistant => ({
  ...assistant,
  flare: { mood, text, until: now + FLARE_MS },
})

/** Records something the routing side did, so it shows in Clawd's feed. */
export const noteEvent = (
  assistant: Assistant,
  input: { kind: FeedKind; text: string; tokens?: number; now: number },
): Assistant => {
  const mood: Mood = input.kind === 'escalate' ? 'alert' : 'happy'

  return withFlare(
    withFeed(assistant, { at: input.now, kind: input.kind, text: input.text, tokens: input.tokens ?? 0 }),
    mood,
    input.text,
    input.now,
  )
}

const listOf = (words: readonly string[]): string =>
  words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`

/**
 * A shell's output is about to be stored: trims it when that saves enough.
 * Answers the text to store instead, or undefined to store it as it came.
 */
export const onToolOutput = (
  assistant: Assistant,
  input: {
    tool: string
    /** The shell command that produced the output, when known. */
    command?: string | undefined
    text: string
    isEnabled: boolean
    isDryRun: boolean
    now: number
  },
): AssistantStep<{ text: string | undefined }> => {
  if (!input.isEnabled || !assistant.config.isTrimming || !TRIMMED_TOOLS.includes(input.tool)) {
    return still(assistant, { text: undefined })
  }

  // A search or a listing printed what was asked for: nothing is folded or cut from it.
  const isAsked = isInspecting(input.command)
  const result = trimOutput(input.text, {
    level: isAsked ? 'lossless' : assistant.config.trimLevel,
    maxLines: isAsked ? Number.MAX_SAFE_INTEGER : assistant.config.maxOutputLines,
  })
  const cut = result.beforeTokens - result.afterTokens

  if (result.actions.length === 0) {
    return still(assistant, { text: undefined })
  }

  const what = listOf(result.actions.map(action => ACTION_WORDS[action]))

  if (input.isDryRun) {
    return still(
      withFeed(assistant, {
        at: input.now,
        kind: 'info',
        text: `dry-run: would trim ${formatTokens(cut)} from ${input.tool} output (${what})`,
        tokens: 0,
      }),
      { text: undefined },
    )
  }

  const text = `Ate ${formatTokens(cut)} tokens of ${input.tool} noise: ${what}`

  return still(
    withFlare(
      withFeed(
        {
          ...assistant,
          trims: assistant.trims + 1,
          trimmed: assistant.trimmed + cut,
          live: assistant.live + cut,
        },
        { at: input.now, kind: 'trim', text, tokens: cut },
      ),
      'chomp',
      text,
      input.now,
    ),
    { text: result.text },
  )
}

/**
 * A prompt the person typed: remembers it for compaction instructions, wakes
 * Clawd, and cleans a pasted log in it, losslessly. Prose is never touched.
 */
export const onPromptText = (
  assistant: Assistant,
  input: { text: string; isFromUser: boolean; isEnabled: boolean; isDryRun: boolean; now: number },
): AssistantStep<{ text: string | undefined }> => {
  const woken: Assistant = {
    ...assistant,
    isTurnRunning: true,
    isCold: false,
    prompts: input.isFromUser ? [...assistant.prompts, input.text].slice(-MAX_PROMPTS) : assistant.prompts,
  }

  if (
    !input.isEnabled ||
    !input.isFromUser ||
    input.isDryRun ||
    !assistant.config.isTrimmingPastes ||
    !looksLikeLog(input.text)
  ) {
    return still(woken, { text: undefined })
  }

  const result = trimOutput(input.text, { level: 'lossless', maxLines: Number.MAX_SAFE_INTEGER })
  const cut = result.beforeTokens - result.afterTokens

  if (result.actions.length === 0) {
    return still(woken, { text: undefined })
  }

  const text = `Tidied your pasted log: −${formatTokens(cut)} tokens (${listOf(result.actions.map(action => ACTION_WORDS[action]))})`

  return {
    assistant: withFlare(
      withFeed(
        {
          ...woken,
          pastes: woken.pastes + 1,
          pasteTrimmed: woken.pasteTrimmed + cut,
          live: woken.live + cut,
        },
        { at: input.now, kind: 'paste', text, tokens: cut },
      ),
      'chomp',
      text,
      input.now,
    ),
    effects: [{ kind: 'toast', text: `Clawd: ${text}` }],
    reply: { text: result.text },
  }
}

/** One main-loop model request: everything trimmed so far was not re-sent with it. */
export const onMainRequest = (assistant: Assistant): Assistant => ({
  ...assistant,
  reReads: assistant.reReads + assistant.live,
})

export const onTurnEnd = (assistant: Assistant, now: number): Assistant => ({
  ...assistant,
  isTurnRunning: false,
  lastTurnEndAt: now,
})

export const fillOf = (assistant: Assistant): number =>
  percentOf(assistant.context.tokens, assistant.context.window)

/**
 * The window was measured. Crossing into a fuller level says so once; past
 * the auto-compact mark, between turns, Clawd compacts by itself.
 */
export const onContext = (
  assistant: Assistant,
  input: { tokens: number | undefined; window: number; isEnabled: boolean; now: number },
): AssistantStep<undefined> => {
  const measured: Assistant = {
    ...assistant,
    context: { tokens: input.tokens ?? assistant.context.tokens, window: input.window },
  }
  const percent = fillOf(measured)
  const level = levelOf(percent)

  if (!input.isEnabled) {
    return still(measured, undefined)
  }

  // Emptier than warned (a compaction, a /clear): ready to warn again.
  if (rankOfLevel(level) < rankOfLevel(measured.warnedLevel)) {
    return still({ ...measured, warnedLevel: level }, undefined)
  }

  const effects: AssistantEffect[] = []
  let next = measured

  if (rankOfLevel(level) > rankOfLevel(measured.warnedLevel) && level !== 'filling') {
    const saving = compactSaving(measured.context.tokens)
    const text =
      level === 'critical'
        ? `Context at ${String(percent)}%: compact now, before Claude Code does it mid-task. Every request carries ${formatTokens(measured.context.tokens)} tokens.`
        : `Context at ${String(percent)}%. Compacting would take ~${formatTokens(saving)} tokens off every request.`

    next = withFlare(
      withFeed({ ...next, warnedLevel: level }, { at: input.now, kind: 'warn', text, tokens: 0 }),
      'worried',
      text,
      input.now,
    )
    effects.push({ kind: 'toast', text: `Clawd: ${text}` })
  } else if (level === 'filling' && measured.warnedLevel === 'calm') {
    next = { ...next, warnedLevel: level }
  }

  const autoAt = next.config.autoCompactAt

  if (
    autoAt > 0 &&
    percent >= autoAt &&
    !next.isTurnRunning &&
    !next.isCompacting &&
    next.context.tokens >= MIN_WORTHWHILE_TOKENS
  ) {
    next = { ...next, isCompacting: true }
    effects.push({ kind: 'compact', instructions: compactInstructions(next.prompts) })
  }

  return { assistant: next, effects, reply: undefined }
}

/** The clock checked the idle session: a cache past its life makes the next message expensive. */
export const onIdleCheck = (assistant: Assistant, input: { now: number; isEnabled: boolean }): Assistant => {
  if (!input.isEnabled || assistant.isCold || assistant.lastTurnEndAt === undefined) {
    return assistant
  }

  const isCold = isCacheCold({
    idleMs: input.now - assistant.lastTurnEndAt,
    ttlMs: assistant.config.cacheTtlMinutes * 60_000,
    tokens: assistant.context.tokens,
    isTurnRunning: assistant.isTurnRunning,
  })

  if (!isCold) {
    return assistant
  }

  const cost = coldCost(assistant.context.tokens)

  return withFeed(
    { ...assistant, isCold: true },
    {
      at: input.now,
      kind: 'cold',
      text: `Cache went cold. Next message re-writes ~${formatTokens(cost.now)} tokens; after a compact, ~${formatTokens(cost.compacted)}.`,
      tokens: 0,
    },
  )
}

/** Asked to compact (a button, a command): the instructions to send, or why not. */
export const requestCompact = (
  assistant: Assistant,
): AssistantStep<{ instructions: string | undefined; why: string | undefined }> => {
  if (assistant.isTurnRunning) {
    return still(assistant, { instructions: undefined, why: 'Claude is mid-turn; compact when it finishes.' })
  }

  if (assistant.isCompacting) {
    return still(assistant, { instructions: undefined, why: 'Already compacting.' })
  }

  return still({ ...assistant, isCompacting: true }, {
    instructions: compactInstructions(assistant.prompts),
    why: undefined,
  })
}

/** A compaction ended, whoever started it. */
export const onCompacted = (
  assistant: Assistant,
  input: { before: number | undefined; after: number | undefined; isSkipped: boolean; now: number },
): Assistant => {
  if (input.isSkipped) {
    return { ...assistant, isCompacting: false }
  }

  const before = input.before ?? assistant.context.tokens
  const after = input.after ?? afterCompact(before)
  const freed = Math.max(0, before - after)
  const text = `Compacted: ${formatTokens(before)} → ${formatTokens(after)} tokens. Every request is lighter now.`

  return withFlare(
    withFeed(
      {
        ...assistant,
        isCompacting: false,
        isCold: false,
        live: 0,
        compactions: assistant.compactions + 1,
        compactFreed: assistant.compactFreed + freed,
        context: { ...assistant.context, tokens: after },
        warnedLevel: 'calm',
      },
      { at: input.now, kind: 'compact', text, tokens: freed },
    ),
    'happy',
    text,
    input.now,
  )
}

export const withAssistantConfig = (assistant: Assistant, config: AssistantConfig): Assistant => ({
  ...assistant,
  config,
})

/** True while a passing mood is still showing. */
export const hasFlare = (assistant: Assistant, now: number): boolean =>
  assistant.flare !== undefined && now < assistant.flare.until

/** The mood Clawd shows now: a passing one first, then what the session's state calls for. */
export const moodOf = (
  assistant: Assistant,
  input: { now: number; isEnabled: boolean; activeAgents: number },
): Mood => {
  if (!input.isEnabled) {
    return 'off'
  }

  if (assistant.flare !== undefined && hasFlare(assistant, input.now)) {
    return assistant.flare.mood
  }

  if (assistant.isCold) {
    return 'sleepy'
  }

  if (rankOfLevel(levelOf(fillOf(assistant))) >= rankOfLevel('heavy')) {
    return 'worried'
  }

  return input.activeAgents > 0 || assistant.isTurnRunning ? 'busy' : 'idle'
}

/** What Clawd says in the speech bubble. */
export const speechOf = (
  assistant: Assistant,
  input: { now: number; isEnabled: boolean; activeAgents: number },
): string => {
  const mood = moodOf(assistant, input)
  const percent = fillOf(assistant)

  switch (mood) {
    case 'off':
      return 'Off duty. Turn me on and I start eating noise.'
    case 'sleepy': {
      const cost = coldCost(assistant.context.tokens)

      return `Zzz… cache went cold. Your next message re-writes ~${formatTokens(cost.now)} tokens. Compact first and it's ~${formatTokens(cost.compacted)}.`
    }
    case 'worried':
      return assistant.flare !== undefined && hasFlare(assistant, input.now)
        ? assistant.flare.text
        : `Context at ${String(percent)}%. Compacting takes ~${formatTokens(compactSaving(assistant.context.tokens))} off every request.`
    case 'busy':
      return input.activeAgents > 0
        ? `${String(input.activeAgents)} helper${input.activeAgents === 1 ? '' : 's'} on cheaper models. I'm watching the output.`
        : 'Watching tool output for noise to eat…'
    case 'chomp':
    case 'happy':
    case 'alert':
      return assistant.flare?.text ?? ''
    case 'idle':
      return assistant.trimmed > 0
        ? `${formatTokens(assistant.trimmed + assistant.pasteTrimmed)} tokens eaten so far, ~${formatTokens(assistant.reReads)} re-sends avoided.`
        : 'Hi! I trim noisy output before it fills your context, and tell you when to compact.'
  }
}
