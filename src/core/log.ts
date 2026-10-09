import { isCheckSignal } from './escalate.ts'
import type { CheckSignal } from './escalate.ts'
import { DEFAULT_THRESHOLDS } from './route.ts'
import type { Cutoffs, Thresholds } from './route.ts'
import { TASK_TYPES, isTaskType } from './score.ts'
import type { TaskType } from './score.ts'
import { TIERS, isTier } from './tiers.ts'
import type { Tier } from './tiers.ts'

/** One finished delegation, as the local outcome log keeps it. No prompt text is stored. */
export type Outcome = {
  seq: number
  at: number
  taskType: TaskType
  tier: Tier
  tokens: number
  retries: number
  wasEscalated: boolean
  isSuccess: boolean
  signal: CheckSignal
}

/** The log is capped so it stays far below the store's size limit. */
export const MAX_OUTCOMES = 500

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** Reads one stored entry, or undefined when it is not a well-formed outcome. */
export const parseOutcome = (value: unknown): Outcome | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  const { seq, at, taskType, tier, tokens, retries, wasEscalated, isSuccess, signal } = value

  if (
    !isCount(seq) ||
    !isCount(at) ||
    !isTaskType(taskType) ||
    !isTier(tier) ||
    !isCount(tokens) ||
    !isCount(retries) ||
    typeof wasEscalated !== 'boolean' ||
    typeof isSuccess !== 'boolean' ||
    !isCheckSignal(signal)
  ) {
    return undefined
  }

  return { seq, at, taskType, tier, tokens, retries, wasEscalated, isSuccess, signal }
}

export type ParsedLog = {
  outcomes: readonly Outcome[]
  /** Entries that were present but unreadable, including a log that was not a list at all. */
  dropped: number
}

/**
 * Reads the stored log defensively. A missing log is empty; a corrupted one
 * keeps every entry that still parses and counts the rest as dropped.
 */
export const parseLog = (value: unknown): ParsedLog => {
  if (value === undefined || value === null) {
    return { outcomes: [], dropped: 0 }
  }

  if (!Array.isArray(value)) {
    return { outcomes: [], dropped: 1 }
  }

  const entries: readonly unknown[] = value
  const outcomes = entries
    .map(parseOutcome)
    .filter(outcome => outcome !== undefined)
    .slice(-MAX_OUTCOMES)

  return { outcomes, dropped: entries.length - outcomes.length }
}

export const nextSeq = (outcomes: readonly Outcome[]): number =>
  outcomes.reduce((highest, outcome) => Math.max(highest, outcome.seq), 0) + 1

export const appendOutcome = (outcomes: readonly Outcome[], outcome: Outcome): readonly Outcome[] =>
  [...outcomes, outcome].slice(-MAX_OUTCOMES)

/** A clean outcome is the only evidence that counts toward loosening a rule. */
export const isCleanSuccess = (outcome: Outcome): boolean =>
  outcome.isSuccess && !outcome.wasEscalated && outcome.retries === 0

const clampCutoff = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.round(value)))
    : fallback

const parseCutoffs = (value: unknown, fallback: Cutoffs): Cutoffs => {
  if (!isRecord(value)) {
    return fallback
  }

  const haikuMax = clampCutoff(value['haikuMax'], fallback.haikuMax)
  const sonnetMax = Math.max(haikuMax, clampCutoff(value['sonnetMax'], fallback.sonnetMax))
  const tunedAtSeq = isCount(value['tunedAtSeq']) ? value['tunedAtSeq'] : 0

  return { haikuMax, sonnetMax, tunedAtSeq }
}

/** Reads stored thresholds, falling back to the default for anything missing or malformed. */
export const parseThresholds = (value: unknown): Thresholds => {
  const stored = isRecord(value) ? value : {}

  return {
    search: parseCutoffs(stored['search'], DEFAULT_THRESHOLDS.search),
    'bulk-read': parseCutoffs(stored['bulk-read'], DEFAULT_THRESHOLDS['bulk-read']),
    'repetitive-edit': parseCutoffs(
      stored['repetitive-edit'],
      DEFAULT_THRESHOLDS['repetitive-edit'],
    ),
    summarize: parseCutoffs(stored['summarize'], DEFAULT_THRESHOLDS.summarize),
    edit: parseCutoffs(stored['edit'], DEFAULT_THRESHOLDS.edit),
    reasoning: parseCutoffs(stored['reasoning'], DEFAULT_THRESHOLDS.reasoning),
    general: parseCutoffs(stored['general'], DEFAULT_THRESHOLDS.general),
  }
}

export type LogSummary = {
  count: number
  cleanRate: number
  escalations: number
  failures: number
  byTier: Readonly<Record<Tier, number>>
}

export const summarizeLog = (outcomes: readonly Outcome[]): LogSummary => {
  const clean = outcomes.filter(isCleanSuccess).length
  const countAt = (tier: Tier): number => outcomes.filter(outcome => outcome.tier === tier).length

  return {
    count: outcomes.length,
    cleanRate: outcomes.length === 0 ? 1 : clean / outcomes.length,
    escalations: outcomes.filter(outcome => outcome.wasEscalated).length,
    failures: outcomes.filter(outcome => !outcome.isSuccess).length,
    byTier: { haiku: countAt('haiku'), sonnet: countAt('sonnet'), opus: countAt('opus') },
  }
}

export type ExportBundle = {
  format: 'tokensaver-export'
  version: 1
  exportedAt: number
  taskTypes: readonly TaskType[]
  tiers: readonly Tier[]
  thresholds: Thresholds
  summary: LogSummary
  outcomes: readonly Outcome[]
}

/** Everything `/tokensaver export` writes: the log, the tuned thresholds and a summary. */
export const buildExport = (
  outcomes: readonly Outcome[],
  thresholds: Thresholds,
  exportedAt: number,
): ExportBundle => ({
  format: 'tokensaver-export',
  version: 1,
  exportedAt,
  taskTypes: TASK_TYPES,
  tiers: TIERS,
  thresholds,
  summary: summarizeLog(outcomes),
  outcomes,
})
