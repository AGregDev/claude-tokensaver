/**
 * Decides whether handing a task's bulk reading to a sub-agent would save
 * tokens overall. tokensaver never starts a sub-agent itself: this only
 * decides whether to suggest it to Claude, which makes the final call.
 */
import { isRecord } from './log.ts'
import { costWeightAt } from './savings.ts'
import type { TaskScore, TaskType } from './score.ts'

/** Task types whose bulk can be handed to a sub-agent and returned as a short report. */
export const DELEGABLE_TYPES: readonly TaskType[] = [
  'search',
  'bulk-read',
  'repetitive-edit',
  'summarize',
]

/**
 * What starting a sub-agent costs before it does any work: its own system
 * prompt and tool list. Measured in live sessions at 30k to 38k tokens.
 */
export const SPAWN_OVERHEAD_TOKENS = 30_000

/** A rough size for one source file read into context. */
export const TOKENS_PER_FILE = 1500

/**
 * What read content costs again later: it stays in the main context and is
 * re-read from the prompt cache, at about a tenth of the price, on each of
 * the turn's remaining requests (taken as eight).
 */
export const CARRY_FACTOR = 0.8

/** The report a sub-agent hands back, which the main context does keep. */
export const REPORT_TOKENS = 800

/** A suggestion must be predicted to save at least this much. Tuned from outcomes. */
export const DEFAULT_MIN_SAVING = 4000
export const MIN_SAVING_FLOOR = 2000
export const MIN_SAVING_CEILING = 60_000

/** The repository size assumed when it could not be measured. */
export const UNKNOWN_REPO_FILES = 100

/** No estimate assumes more files than this get read for one task. */
const MAX_FILES = 60

/** Of a repository, the share a broad task of each type tends to read. */
const REPO_SHARE: Readonly<Record<TaskType, number>> = {
  search: 0.08,
  'bulk-read': 0.5,
  summarize: 0.5,
  'repetitive-edit': 0.3,
  edit: 0,
  reasoning: 0,
  general: 0,
}

/** One sub-agent per this much reading, up to three in parallel. */
const TOKENS_PER_AGENT = 45_000
const MAX_AGENTS = 3

export type DelegationFacts = {
  /** Files in the working directory, counted once per session; undefined when unknown. */
  repoFiles: number | undefined
  /** The rank of the session's model; undefined when its family is unknown. */
  parentRank: number | undefined
  minSaving: number
}

export type DelegationDecision = {
  shouldDelegate: boolean
  estimatedFiles: number
  estimatedSaving: number
  /** How many sub-agents the reading is worth splitting across. */
  agents: number
  reason: string
}

const no = (reason: string, estimatedFiles = 0, estimatedSaving = 0): DelegationDecision => ({
  shouldDelegate: false,
  estimatedFiles,
  estimatedSaving,
  agents: 0,
  reason,
})

/** How many files the task is likely to read: the ones it names, or a share of the repository. */
export const estimateFiles = (score: TaskScore, repoFiles: number | undefined): number => {
  const isBroad = score.features.scope >= 0.34
  const fromRepo = isBroad
    ? Math.round((repoFiles ?? UNKNOWN_REPO_FILES) * REPO_SHARE[score.taskType] * score.features.scope)
    : 0

  return Math.min(MAX_FILES, Math.max(score.namedFiles, fromRepo))
}

/**
 * Compares doing the reading inline with delegating it, in tokens of the
 * session's own model. Inline, the content is read once and then carried.
 * Delegated, a cheaper model pays the sub-agent's start-up and the reading,
 * and the main context keeps only the report.
 */
export const decideDelegation = (score: TaskScore, facts: DelegationFacts): DelegationDecision => {
  if (!DELEGABLE_TYPES.includes(score.taskType)) {
    return no('not a delegable kind of task')
  }

  if (score.isRisky) {
    return no('risky, kept in the main loop')
  }

  if (facts.parentRank === undefined) {
    return no('the session model is not one tokensaver can compare')
  }

  const estimatedFiles = estimateFiles(score, facts.repoFiles)
  const reading = estimatedFiles * TOKENS_PER_FILE
  const cheaper = costWeightAt(0) / costWeightAt(facts.parentRank)
  const inline = reading * (1 + CARRY_FACTOR)
  const delegated = SPAWN_OVERHEAD_TOKENS * cheaper + reading * cheaper + REPORT_TOKENS
  const estimatedSaving = Math.round(inline - delegated)

  if (estimatedSaving < facts.minSaving) {
    return no(
      'starting a sub-agent would cost more than it saves',
      estimatedFiles,
      Math.max(0, estimatedSaving),
    )
  }

  return {
    shouldDelegate: true,
    estimatedFiles,
    estimatedSaving,
    agents: Math.min(MAX_AGENTS, Math.max(1, Math.ceil(reading / TOKENS_PER_AGENT))),
    reason: 'bulk reading a cheaper sub-agent can report on',
  }
}

/** How a suggestion turned out, judged when its turn ends. */
export type HintVerdict = 'paid-off' | 'over-fired' | 'unclear'

export type HintEvidence = {
  /** Tokens of the largest sub-agent the turn started, or 0 when it started none. */
  largestAgentTokens: number
  /** Files the main loop read or searched itself that turn. */
  mainReads: number
}

/** A sub-agent that did less than this beyond its start-up was not worth starting. */
const WORTHWHILE_AGENT_TOKENS = SPAWN_OVERHEAD_TOKENS + 10 * TOKENS_PER_FILE

/** Reading fewer files than this inline shows the task was small after all. */
const SMALL_TASK_READS = 4

export const judgeHint = (evidence: HintEvidence): HintVerdict => {
  if (evidence.largestAgentTokens > 0) {
    return evidence.largestAgentTokens >= WORTHWHILE_AGENT_TOKENS ? 'paid-off' : 'over-fired'
  }

  // Claude declined. If it then read little, it was right, and the suggestion was not.
  return evidence.mainReads < SMALL_TASK_READS ? 'over-fired' : 'unclear'
}

/**
 * Tunes the bar a suggestion must clear. As with routing, it is lopsided:
 * one suggestion that was not worth it raises the bar by a quarter at once,
 * and one that paid off lowers it by a few percent.
 */
export const tuneMinSaving = (minSaving: number, verdict: HintVerdict): number => {
  if (verdict === 'over-fired') {
    return Math.min(MIN_SAVING_CEILING, Math.round(minSaving * 1.25))
  }

  return verdict === 'paid-off' ? Math.max(MIN_SAVING_FLOOR, Math.round(minSaving * 0.97)) : minSaving
}

/** Reads the stored bar, falling back to the default for anything missing or malformed. */
export const parseMinSaving = (value: unknown): number => {
  const stored = isRecord(value) ? value['minSaving'] : undefined

  return typeof stored === 'number' && Number.isFinite(stored)
    ? Math.min(MIN_SAVING_CEILING, Math.max(MIN_SAVING_FLOOR, Math.round(stored)))
    : DEFAULT_MIN_SAVING
}
