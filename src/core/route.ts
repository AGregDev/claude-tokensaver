import type { TaskScore, TaskType } from './score.ts'
import { TOP_RANK, nextTierUp, rankOf, rankOfModel, tierAt } from './tiers.ts'
import type { Tier } from './tiers.ts'

/** A complexity below `haikuMax` runs on Haiku, below `sonnetMax` on Sonnet, the rest on Opus. */
export type Cutoffs = {
  haikuMax: number
  sonnetMax: number
  /** The log sequence number these cutoffs were last tuned at; older outcomes are spent evidence. */
  tunedAtSeq: number
}

export type Thresholds = Readonly<Record<TaskType, Cutoffs>>

/**
 * Starting cutoffs. Mechanical work gets generous ones; reasoning and
 * unknown work get tight ones, so an unrecognised task defaults upward.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  search: { haikuMax: 45, sonnetMax: 75, tunedAtSeq: 0 },
  'bulk-read': { haikuMax: 40, sonnetMax: 75, tunedAtSeq: 0 },
  summarize: { haikuMax: 35, sonnetMax: 70, tunedAtSeq: 0 },
  'repetitive-edit': { haikuMax: 30, sonnetMax: 65, tunedAtSeq: 0 },
  edit: { haikuMax: 15, sonnetMax: 55, tunedAtSeq: 0 },
  reasoning: { haikuMax: 5, sonnetMax: 35, tunedAtSeq: 0 },
  general: { haikuMax: 10, sonnetMax: 50, tunedAtSeq: 0 },
}

export type RouteDecision = {
  tier: Tier
  /** The tier the cutoffs alone picked, before any upward adjustment. */
  base: Tier
  reasons: readonly string[]
}

const bump = (tier: Tier): Tier => nextTierUp(tier) ?? tier

/**
 * Picks a tier for a scored task. Every adjustment after the cutoffs moves
 * up: a boundary tie, an unsure score, a boost and a risky task all raise.
 */
export const routeTier = (score: TaskScore, thresholds: Thresholds, boost = 0): RouteDecision => {
  const cutoffs = thresholds[score.taskType]
  const base: Tier =
    score.complexity < cutoffs.haikuMax
      ? 'haiku'
      : score.complexity < cutoffs.sonnetMax
        ? 'sonnet'
        : 'opus'
  const reasons: string[] = [`${score.taskType} at complexity ${String(score.complexity)}`]
  let tier = base

  if (score.isUnsure) {
    tier = bump(tier)
    reasons.push('unsure, so one tier up')
  }

  for (let step = 0; step < boost; step += 1) {
    tier = bump(tier)
  }

  if (boost > 0) {
    reasons.push('previous result rejected, so one tier up')
  }

  if (score.isRisky) {
    tier = 'opus'
    reasons.push(`risky (${score.risks.join(', ')}), so never below the top tier`)
  }

  return { tier, base, reasons }
}

export type SpawnContext = {
  /** The parent's effective model id: what the sub-agent inherits when no model is set. */
  parentModel: string
  /** A model the caller asked for by name, if any. */
  explicitModel?: string | undefined
  /** A tier an escalation retry must run on. */
  forcedTier?: Tier | undefined
}

export type SpawnRouting = {
  /** The model to hand `agent.spawn`, or undefined to leave the spawn exactly as it came. */
  model: string | undefined
  /** The tier the sub-agent runs on, for the log and the dashboard; undefined when unknown. */
  tier: Tier | undefined
  note: string
}

/** A family above the top routable tier has no tier name of its own. */
const tierForRank = (rank: number): Tier | undefined =>
  rank > TOP_RANK ? undefined : tierAt(rank)

/**
 * Turns a tier decision into the model a spawn should run on.
 *
 * Invariants the safety tests hold this to: a risky task never runs below the
 * parent's tier or below a model the caller named, and an unknown parent
 * model is never rerouted.
 */
export const resolveSpawnModel = (
  decision: RouteDecision,
  score: TaskScore,
  context: SpawnContext,
): SpawnRouting => {
  if (context.forcedTier !== undefined) {
    return { model: context.forcedTier, tier: context.forcedTier, note: 'escalation retry' }
  }

  const parentRank = rankOfModel(context.parentModel)
  const explicitRank = rankOfModel(context.explicitModel)

  if (parentRank === undefined) {
    return { model: undefined, tier: undefined, note: 'unknown parent model, left as is' }
  }

  if (context.explicitModel !== undefined && explicitRank === undefined) {
    return { model: undefined, tier: undefined, note: 'caller named an unknown model, left as is' }
  }

  const decided = rankOf(decision.tier)
  // The top decision means "the best available": under a parent above Opus that is the parent.
  const wanted = explicitRank ?? (decision.tier === 'opus' ? Math.max(decided, parentRank) : decided)
  const floor = score.isRisky ? Math.max(parentRank, explicitRank ?? 0) : 0
  const final = Math.max(wanted, floor)
  const current = explicitRank ?? parentRank

  if (final === current) {
    return {
      model: undefined,
      tier: tierForRank(final),
      note: context.explicitModel === undefined ? 'inherits the parent model' : 'caller chose the model',
    }
  }

  // Reaching the parent's rank from a lower named model: name the parent's own model.
  if (final === parentRank) {
    return {
      model: context.parentModel,
      tier: tierForRank(final),
      note: 'risky, raised to the parent model',
    }
  }

  return { model: tierAt(final), tier: tierAt(final), note: decision.reasons.join('; ') }
}
