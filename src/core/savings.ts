import { TOP_RANK } from './tiers.ts'

/**
 * Relative cost of a token on each tier, by rank (Haiku, Sonnet, Opus). They
 * are ratios for estimating, not prices; anything above Opus is weighed as
 * Opus, which can only understate a saving.
 */
export const COST_WEIGHTS: readonly [number, number, number] = [1, 3, 5]

const weightAt = (rank: number): number => {
  if (rank <= 0) {
    return COST_WEIGHTS[0]
  }

  return rank >= TOP_RANK ? COST_WEIGHTS[2] : COST_WEIGHTS[1]
}

/** The usual rule of thumb for English text and code: about four characters a token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

/**
 * What running `tokens` on a cheaper tier saved, in tokens of the baseline
 * tier. Negative when the work was routed up: escalation is counted as a cost.
 */
export const routingSavings = (tokens: number, usedRank: number, baselineRank: number): number =>
  Math.round(tokens * (1 - weightAt(usedRank) / weightAt(baselineRank)))

/**
 * What delegating kept out of the main context: the work the sub-agent read
 * and wrote, less the summary it handed back. Never negative.
 */
export const contextSavings = (workTokens: number, answerTokens: number): number =>
  Math.max(0, workTokens - answerTokens)
