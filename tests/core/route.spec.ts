import { describe, expect, it } from 'vitest'

import {
  DEFAULT_THRESHOLDS,
  HANDOFF_OVERHEAD_TOKENS,
  decideDelegation,
  estimateWorkTokens,
  resolveSpawnModel,
  routeTier,
} from '../../src/core/route.ts'
import type { RouteDecision } from '../../src/core/route.ts'
import { scoreTask } from '../../src/core/score.ts'
import type { TaskScore, TaskType } from '../../src/core/score.ts'
import {
  TIERS,
  isTier,
  nextTierUp,
  rankOf,
  rankOfModel,
  tierAt,
  tierOfModel,
} from '../../src/core/tiers.ts'
import { FABLE, HAIKU, OPUS, SEARCH_PROMPT, SONNET } from '../helpers.ts'

const scored = (taskType: TaskType, complexity: number, extra: Partial<TaskScore> = {}): TaskScore => ({
  taskType,
  features: { scope: 0, files: 0, ambiguity: 0, depth: 0, risk: 0 },
  complexity,
  isRisky: false,
  risks: [],
  isUnsure: false,
  ...extra,
})

const decided = (tier: RouteDecision['tier']): RouteDecision => ({ tier, base: tier, reasons: [] })

describe('tiers', () => {
  it('orders haiku below sonnet below opus', () => {
    expect(TIERS.map(rankOf)).toEqual([0, 1, 2])
    expect([-3, 0, 1, 2, 9].map(tierAt)).toEqual(['haiku', 'haiku', 'sonnet', 'opus', 'opus'])
  })

  it('moves one tier up, and stops at the top', () => {
    expect(nextTierUp('haiku')).toBe('sonnet')
    expect(nextTierUp('sonnet')).toBe('opus')
    expect(nextTierUp('opus')).toBeUndefined()
  })

  it('reads a tier from a model id or alias', () => {
    expect(tierOfModel(HAIKU)).toBe('haiku')
    expect(tierOfModel('sonnet')).toBe('sonnet')
    expect(tierOfModel('us.anthropic.claude-opus-5-5-v1:0')).toBe('opus')
    expect(rankOfModel(FABLE)).toBe(3)
    expect(tierOfModel(FABLE)).toBeUndefined()
    expect(tierOfModel('gpt-9')).toBeUndefined()
    expect(rankOfModel(undefined)).toBeUndefined()
  })

  it('recognises tier names', () => {
    expect(isTier('haiku')).toBe(true)
    expect(isTier('fable')).toBe(false)
    expect(isTier(2)).toBe(false)
  })
})

describe('routeTier', () => {
  it('routes by the cutoffs of the task type', () => {
    expect(routeTier(scored('search', 10), DEFAULT_THRESHOLDS).tier).toBe('haiku')
    expect(routeTier(scored('search', 60), DEFAULT_THRESHOLDS).tier).toBe('sonnet')
    expect(routeTier(scored('search', 90), DEFAULT_THRESHOLDS).tier).toBe('opus')
  })

  it('sends a complexity exactly on a cutoff to the higher tier', () => {
    const { haikuMax, sonnetMax } = DEFAULT_THRESHOLDS.search

    expect(routeTier(scored('search', haikuMax - 1), DEFAULT_THRESHOLDS).tier).toBe('haiku')
    expect(routeTier(scored('search', haikuMax), DEFAULT_THRESHOLDS).tier).toBe('sonnet')
    expect(routeTier(scored('search', sonnetMax), DEFAULT_THRESHOLDS).tier).toBe('opus')
  })

  it('uses tighter cutoffs for reasoning than for mechanical work', () => {
    expect(routeTier(scored('search', 20), DEFAULT_THRESHOLDS).tier).toBe('haiku')
    expect(routeTier(scored('reasoning', 20), DEFAULT_THRESHOLDS).tier).toBe('sonnet')
    expect(routeTier(scored('reasoning', 40), DEFAULT_THRESHOLDS).tier).toBe('opus')
  })

  it('goes up one tier when unsure, never down', () => {
    const sure = routeTier(scored('edit', 5), DEFAULT_THRESHOLDS)
    const unsure = routeTier(scored('edit', 5, { isUnsure: true }), DEFAULT_THRESHOLDS)

    expect(sure.tier).toBe('haiku')
    expect(unsure.tier).toBe('sonnet')
    expect(unsure.base).toBe('haiku')
    expect(routeTier(scored('edit', 99, { isUnsure: true }), DEFAULT_THRESHOLDS).tier).toBe('opus')
  })

  it('treats an unknown task type conservatively', () => {
    const general = scoreTask({ text: 'hello there friend' })

    expect(general.taskType).toBe('general')
    expect(rankOf(routeTier(general, DEFAULT_THRESHOLDS).tier)).toBeGreaterThanOrEqual(1)
  })

  it('adds the boost on top', () => {
    expect(routeTier(scored('search', 10), DEFAULT_THRESHOLDS, 1).tier).toBe('sonnet')
    expect(routeTier(scored('search', 10), DEFAULT_THRESHOLDS, 5).tier).toBe('opus')
  })

  it('sends a risky task to the top tier whatever its complexity', () => {
    const risky = scored('search', 0, { isRisky: true, risks: ['destructive'] })
    const decision = routeTier(risky, DEFAULT_THRESHOLDS)

    expect(decision.tier).toBe('opus')
    expect(decision.reasons.join(' ')).toContain('destructive')
  })
})

describe('resolveSpawnModel', () => {
  const plain = scored('search', 10)
  const risky = scored('search', 10, { isRisky: true, risks: ['security'] })

  it('routes a mechanical task down from the parent model', () => {
    expect(resolveSpawnModel(decided('haiku'), plain, { parentModel: OPUS })).toMatchObject({
      model: 'haiku',
      tier: 'haiku',
    })
  })

  it('leaves the spawn alone when the decision is the parent tier', () => {
    expect(resolveSpawnModel(decided('sonnet'), plain, { parentModel: SONNET }).model).toBeUndefined()
  })

  it('routes up when the task needs more than the parent', () => {
    expect(resolveSpawnModel(decided('opus'), plain, { parentModel: SONNET }).model).toBe('opus')
  })

  it('respects a model the caller named', () => {
    const routing = resolveSpawnModel(decided('haiku'), plain, {
      parentModel: OPUS,
      explicitModel: 'sonnet',
    })

    expect(routing.model).toBeUndefined()
    expect(routing.tier).toBe('sonnet')
  })

  it('never reroutes under a parent model it does not know', () => {
    const routing = resolveSpawnModel(decided('haiku'), plain, { parentModel: 'some-other-model' })

    expect(routing).toMatchObject({ model: undefined, tier: undefined })
  })

  it('never reroutes a model name it does not know', () => {
    const routing = resolveSpawnModel(decided('haiku'), plain, {
      parentModel: OPUS,
      explicitModel: 'mystery',
    })

    expect(routing.model).toBeUndefined()
  })

  it('keeps the top decision on a parent above opus', () => {
    expect(resolveSpawnModel(decided('opus'), plain, { parentModel: FABLE })).toMatchObject({
      model: undefined,
      tier: undefined,
    })
  })

  it('raises a risky task to the parent model when the caller named a lower one', () => {
    const underOpus = resolveSpawnModel(decided('opus'), risky, {
      parentModel: OPUS,
      explicitModel: 'haiku',
    })
    const underFable = resolveSpawnModel(decided('opus'), risky, {
      parentModel: FABLE,
      explicitModel: 'haiku',
    })

    expect(underOpus.model).toBe(OPUS)
    expect(underFable.model).toBe(FABLE)
  })

  it('runs an escalation retry on the forced tier', () => {
    const routing = resolveSpawnModel(decided('haiku'), plain, {
      parentModel: OPUS,
      explicitModel: 'sonnet',
      forcedTier: 'sonnet',
    })

    expect(routing).toMatchObject({ model: 'sonnet', tier: 'sonnet' })
  })
})

describe('decideDelegation', () => {
  it('delegates broad mechanical work', () => {
    const decision = decideDelegation(scoreTask({ text: SEARCH_PROMPT }))

    expect(decision.shouldDelegate).toBe(true)
    expect(decision.estimatedSavings).toBeGreaterThan(0)
  })

  it('keeps a narrow search inline: the handoff would cost more than it saves', () => {
    const score = scoreTask({ text: 'find parseConfig in src/config.ts' })
    const decision = decideDelegation(score)

    expect(score.taskType).toBe('search')
    expect(decision.shouldDelegate).toBe(false)
    expect(decision.reason).toContain('cost more')
    expect(estimateWorkTokens(score) - HANDOFF_OVERHEAD_TOKENS).toBeLessThan(1500)
  })

  it('keeps reasoning and edits inline', () => {
    expect(decideDelegation(scoreTask({ text: 'design the plugin architecture' })).shouldDelegate).toBe(false)
    expect(decideDelegation(scoreTask({ text: 'add a null check to src/a.ts' })).shouldDelegate).toBe(false)
  })

  it('keeps risky work in the main loop however broad it is', () => {
    const decision = decideDelegation(
      scoreTask({ text: 'find every password across the whole repo and list all files' }),
    )

    expect(decision.shouldDelegate).toBe(false)
    expect(decision.reason).toContain('risky')
  })
})
