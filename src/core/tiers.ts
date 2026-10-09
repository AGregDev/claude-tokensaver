/** The model tiers tokensaver routes between, cheapest first. */
export const TIERS = ['haiku', 'sonnet', 'opus'] as const

export type Tier = (typeof TIERS)[number]

const RANK: Readonly<Record<Tier, number>> = { haiku: 0, sonnet: 1, opus: 2 }

/** The rank of the top routable tier. */
export const TOP_RANK = RANK.opus

/** Model families ranked for comparison only; a family above opus is never routed to by alias. */
const FAMILY_RANKS: readonly (readonly [string, number])[] = [
  ['haiku', 0],
  ['sonnet', 1],
  ['opus', 2],
  ['fable', 3],
]

export const isTier = (value: unknown): value is Tier =>
  value === 'haiku' || value === 'sonnet' || value === 'opus'

export const rankOf = (tier: Tier): number => RANK[tier]

/** The tier at a rank, clamped into the routable range. */
export const tierAt = (rank: number): Tier => {
  if (rank <= RANK.haiku) {
    return 'haiku'
  }

  return rank >= RANK.opus ? 'opus' : 'sonnet'
}

/** One tier up, or undefined at the top: escalation has nowhere lower to go. */
export const nextTierUp = (tier: Tier): Tier | undefined => {
  if (tier === 'haiku') {
    return 'sonnet'
  }

  return tier === 'sonnet' ? 'opus' : undefined
}

/** The rank of a model id or alias, or undefined when its family is not one tokensaver knows. */
export const rankOfModel = (model: string | undefined): number | undefined => {
  if (model === undefined) {
    return undefined
  }

  const lower = model.toLowerCase()

  return FAMILY_RANKS.find(([family]) => lower.includes(family))?.[1]
}

/** The routable tier a model id belongs to, or undefined for an unknown or above-top family. */
export const tierOfModel = (model: string | undefined): Tier | undefined => {
  const rank = rankOfModel(model)

  return rank === undefined || rank > TOP_RANK ? undefined : tierAt(rank)
}
