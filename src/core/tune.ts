import { isCleanSuccess } from './log.ts'
import type { Outcome } from './log.ts'
import { DEFAULT_THRESHOLDS } from './route.ts'
import type { Cutoffs, Thresholds } from './route.ts'
import { TASK_TYPES } from './score.ts'
import type { TaskType } from './score.ts'
import type { Tier } from './tiers.ts'

/**
 * Tuning is deliberately lopsided: one failure tightens by a large step at
 * once, while loosening needs a run of clean evidence and moves by a small one.
 */
export const TUNING = {
  tightenStep: 10,
  loosenStep: 2,
  /** Clean outcomes needed, since the last change, before a cutoff may loosen. */
  minSamples: 12,
  /** How far above its default a cutoff may ever drift. */
  maxDrift: 15,
  /** The gap kept between the Haiku and Sonnet cutoffs. */
  minGap: 5,
  /** A tuning pass runs after this many new outcomes. */
  tuneEvery: 10,
} as const

const withCutoffs = (thresholds: Thresholds, taskType: TaskType, cutoffs: Cutoffs): Thresholds => ({
  ...thresholds,
  [taskType]: cutoffs,
})

/**
 * Tightens the rule that let a task run on `tier`, immediately: fewer tasks
 * of that type reach that tier next time. A failure on Opus has no cheaper
 * rule to blame, so only the evidence window resets.
 */
export const tighten = (
  thresholds: Thresholds,
  taskType: TaskType,
  tier: Tier,
  seq: number,
): Thresholds => {
  const current = thresholds[taskType]
  const haikuMax =
    tier === 'haiku' ? Math.max(0, current.haikuMax - TUNING.tightenStep) : current.haikuMax
  const sonnetMax =
    tier === 'sonnet'
      ? Math.max(haikuMax, current.sonnetMax - TUNING.tightenStep)
      : current.sonnetMax

  return withCutoffs(thresholds, taskType, { haikuMax, sonnetMax, tunedAtSeq: seq })
}

const loosenType = (
  current: Cutoffs,
  defaults: Cutoffs,
  fresh: readonly Outcome[],
  seq: number,
): Cutoffs => {
  // Any failure, retry or escalation in the window blocks loosening for the whole type.
  if (!fresh.every(isCleanSuccess)) {
    return current
  }

  const cleanAt = (tier: Tier): number => fresh.filter(outcome => outcome.tier === tier).length
  const canLoosenHaiku = cleanAt('haiku') >= TUNING.minSamples
  const canLoosenSonnet = cleanAt('sonnet') >= TUNING.minSamples
  const sonnetMax = canLoosenSonnet
    ? Math.min(current.sonnetMax + TUNING.loosenStep, defaults.sonnetMax + TUNING.maxDrift, 100)
    : current.sonnetMax
  const haikuMax = canLoosenHaiku
    ? Math.min(
        current.haikuMax + TUNING.loosenStep,
        defaults.haikuMax + TUNING.maxDrift,
        sonnetMax - TUNING.minGap,
      )
    : current.haikuMax
  const next = { haikuMax: Math.max(current.haikuMax, haikuMax), sonnetMax }
  const hasChanged = next.haikuMax !== current.haikuMax || next.sonnetMax !== current.sonnetMax

  // Evidence is spent once it has moved a cutoff, so the same run cannot loosen twice.
  return hasChanged ? { ...next, tunedAtSeq: seq } : current
}

/**
 * The periodic tuning pass. It only ever loosens, and only for a task type
 * whose outcomes since its last change are all clean and numerous enough.
 * An empty log changes nothing.
 */
export const tuneFromLog = (thresholds: Thresholds, outcomes: readonly Outcome[]): Thresholds => {
  const seq = outcomes.reduce((highest, outcome) => Math.max(highest, outcome.seq), 0)

  return TASK_TYPES.reduce<Thresholds>((tuned, taskType) => {
    const current = tuned[taskType]
    const fresh = outcomes.filter(
      outcome => outcome.taskType === taskType && outcome.seq > current.tunedAtSeq,
    )

    return withCutoffs(
      tuned,
      taskType,
      loosenType(current, DEFAULT_THRESHOLDS[taskType], fresh, seq),
    )
  }, thresholds)
}

/**
 * Folds one new outcome into the thresholds: a failure or an escalation
 * tightens at once, and every `tuneEvery` outcomes a loosening pass runs.
 */
export const learnFromOutcome = (
  thresholds: Thresholds,
  outcomes: readonly Outcome[],
  outcome: Outcome,
): Thresholds => {
  if (!isCleanSuccess(outcome)) {
    return tighten(thresholds, outcome.taskType, outcome.tier, outcome.seq)
  }

  return outcome.seq % TUNING.tuneEvery === 0 ? tuneFromLog(thresholds, outcomes) : thresholds
}
