/**
 * The context guardian's arithmetic: how full the window is, when the prompt
 * cache has gone cold, and what a compaction would save. Pure and cheap: it
 * reads figures Claude Code already reports and calls nothing.
 */

export type GuardLevel = 'calm' | 'filling' | 'heavy' | 'critical'

const LEVELS: readonly GuardLevel[] = ['calm', 'filling', 'heavy', 'critical']

/** Fill percentages at which each level starts. */
export const LEVEL_AT: Readonly<Record<GuardLevel, number>> = {
  calm: 0,
  filling: 50,
  heavy: 70,
  critical: 85,
}

/** Below this much context a cold cache or a compaction is not worth a word. */
export const MIN_WORTHWHILE_TOKENS = 25_000

/** A compaction's summary is usually a small fraction of what it replaces; never assumed below this. */
const SUMMARY_SHARE = 0.1
const MIN_SUMMARY_TOKENS = 4000

/** Writing a prompt to the cache costs 1.25x a plain input token; reading it back, 0.1x. */
export const CACHE_WRITE_WEIGHT = 1.25
export const CACHE_READ_WEIGHT = 0.1

export const percentOf = (tokens: number, window: number): number =>
  window <= 0 ? 0 : Math.min(100, Math.round((tokens / window) * 100))

export const levelOf = (percent: number): GuardLevel =>
  [...LEVELS].reverse().find(level => percent >= LEVEL_AT[level]) ?? 'calm'

export const rankOfLevel = (level: GuardLevel): number => LEVELS.indexOf(level)

/** About how big the conversation would be right after a compaction. */
export const afterCompact = (tokens: number): number =>
  Math.min(tokens, Math.max(MIN_SUMMARY_TOKENS, Math.round(tokens * SUMMARY_SHARE)))

/** Tokens a compaction takes off every request that follows it. */
export const compactSaving = (tokens: number): number => Math.max(0, tokens - afterCompact(tokens))

/** True when the session has sat idle long enough for its cached prompt to have expired. */
export const isCacheCold = (input: {
  idleMs: number
  ttlMs: number
  tokens: number
  isTurnRunning: boolean
}): boolean =>
  !input.isTurnRunning && input.ttlMs > 0 && input.idleMs >= input.ttlMs && input.tokens >= MIN_WORTHWHILE_TOKENS

/**
 * What the next message costs in input-token equivalents with a cold cache:
 * the whole context written to the cache again, versus after a compaction.
 */
export const coldCost = (tokens: number): { now: number; compacted: number } => ({
  now: Math.round(tokens * CACHE_WRITE_WEIGHT),
  compacted: Math.round(afterCompact(tokens) * CACHE_WRITE_WEIGHT),
})

const shorten = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

/**
 * What to tell the summarizer, from what the person has asked for lately:
 * keep the live task sharp and let the exploration around it go.
 */
export const compactInstructions = (recentPrompts: readonly string[]): string => {
  const asks = recentPrompts.slice(-3).map(prompt => `"${shorten(prompt, 140)}"`)

  return [
    'Keep: the current goal and the latest request in full, decisions made and why, files changed and their paths, open TODOs and failing tests.',
    'Drop: raw tool output, file contents that can be re-read, and dead ends.',
    ...(asks.length > 0 ? [`Recent requests, newest last: ${asks.join('; ')}.`] : []),
  ].join(' ')
}
