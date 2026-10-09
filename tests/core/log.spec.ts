import { describe, expect, it } from 'vitest'

import {
  MAX_OUTCOMES,
  appendOutcome,
  buildExport,
  isCleanSuccess,
  isRecord,
  nextSeq,
  parseLog,
  parseOutcome,
  parseThresholds,
  summarizeLog,
} from '../../src/core/log.ts'
import { DEFAULT_THRESHOLDS } from '../../src/core/route.ts'
import { COST_WEIGHTS, contextSavings, estimateTokens, routingSavings } from '../../src/core/savings.ts'
import { cleanRun, outcome } from '../helpers.ts'

describe('parseOutcome', () => {
  it('round-trips a stored outcome', () => {
    const stored: unknown = JSON.parse(JSON.stringify(outcome({ seq: 4 })))

    expect(parseOutcome(stored)).toEqual(outcome({ seq: 4 }))
  })

  it.each([
    ['not an object', 'outcome'],
    ['null', null],
    ['a list', []],
    ['an unknown task type', { ...outcome({ seq: 1 }), taskType: 'poetry' }],
    ['an unknown tier', { ...outcome({ seq: 1 }), tier: 'fable' }],
    ['an unknown signal', { ...outcome({ seq: 1 }), signal: 'meh' }],
    ['a negative token count', { ...outcome({ seq: 1 }), tokens: -5 }],
    ['a non-finite number', { ...outcome({ seq: 1 }), at: Number.NaN }],
    ['a missing flag', { ...outcome({ seq: 1 }), isSuccess: 'yes' }],
    ['a missing field', { seq: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(parseOutcome(value)).toBeUndefined()
  })
})

describe('parseLog', () => {
  it('reads a missing log as empty', () => {
    expect(parseLog(undefined)).toEqual({ outcomes: [], dropped: 0 })
    expect(parseLog(null)).toEqual({ outcomes: [], dropped: 0 })
  })

  it('reads a log that is not a list as corrupted and empty', () => {
    expect(parseLog('garbage')).toEqual({ outcomes: [], dropped: 1 })
    expect(parseLog({ outcomes: [] })).toEqual({ outcomes: [], dropped: 1 })
    expect(parseLog(42)).toEqual({ outcomes: [], dropped: 1 })
  })

  it('keeps the readable entries of a partly corrupted log', () => {
    const parsed = parseLog([
      outcome({ seq: 1 }),
      'junk',
      { ...outcome({ seq: 2 }), taskType: 'from-a-newer-version' },
      outcome({ seq: 3 }),
      null,
    ])

    expect(parsed.outcomes.map(entry => entry.seq)).toEqual([1, 3])
    expect(parsed.dropped).toBe(3)
  })

  it('caps what it reads', () => {
    const parsed = parseLog(cleanRun(MAX_OUTCOMES + 20, 'search', 'haiku'))

    expect(parsed.outcomes).toHaveLength(MAX_OUTCOMES)
    expect(parsed.outcomes.at(-1)?.seq).toBe(MAX_OUTCOMES + 20)
  })
})

describe('the log itself', () => {
  it('numbers outcomes from one and keeps counting past the cap', () => {
    expect(nextSeq([])).toBe(1)
    expect(nextSeq(cleanRun(5, 'search', 'haiku'))).toBe(6)
    expect(nextSeq([outcome({ seq: 900 }), outcome({ seq: 3 })])).toBe(901)
  })

  it('appends and drops the oldest past the cap', () => {
    const full = cleanRun(MAX_OUTCOMES, 'search', 'haiku')
    const appended = appendOutcome(full, outcome({ seq: MAX_OUTCOMES + 1 }))

    expect(appended).toHaveLength(MAX_OUTCOMES)
    expect(appended[0]?.seq).toBe(2)
    expect(appended.at(-1)?.seq).toBe(MAX_OUTCOMES + 1)
  })

  it('counts only an unassisted success as clean', () => {
    expect(isCleanSuccess(outcome({ seq: 1 }))).toBe(true)
    expect(isCleanSuccess(outcome({ seq: 1, isSuccess: false }))).toBe(false)
    expect(isCleanSuccess(outcome({ seq: 1, wasEscalated: true }))).toBe(false)
    expect(isCleanSuccess(outcome({ seq: 1, retries: 1 }))).toBe(false)
  })

  it('summarises', () => {
    const summary = summarizeLog([
      outcome({ seq: 1 }),
      outcome({ seq: 2, tier: 'sonnet', wasEscalated: true, retries: 1 }),
      outcome({ seq: 3, tier: 'opus', isSuccess: false, signal: 'error' }),
      outcome({ seq: 4 }),
    ])

    expect(summary).toEqual({
      count: 4,
      cleanRate: 0.5,
      escalations: 1,
      failures: 1,
      byTier: { haiku: 2, sonnet: 1, opus: 1 },
    })
    expect(summarizeLog([]).cleanRate).toBe(1)
  })

  it('exports the log, the thresholds and a summary, and nothing else', () => {
    const log = cleanRun(3, 'search', 'haiku')
    const bundle = buildExport(log, DEFAULT_THRESHOLDS, 1234)

    expect(Object.keys(bundle).sort()).toEqual(
      ['exportedAt', 'format', 'outcomes', 'summary', 'taskTypes', 'thresholds', 'tiers', 'version'].sort(),
    )
    expect(bundle.outcomes).toEqual(log)
    expect(bundle.exportedAt).toBe(1234)
    expect(bundle.summary.count).toBe(3)
    // An outcome holds counts and labels only: no prompt or file text.
    expect(Object.keys(log[0] ?? {}).sort()).toEqual(
      ['at', 'isSuccess', 'retries', 'seq', 'signal', 'taskType', 'tier', 'tokens', 'wasEscalated'].sort(),
    )
  })
})

describe('parseThresholds', () => {
  it('falls back to the defaults for anything missing', () => {
    expect(parseThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS)
    expect(parseThresholds('nope')).toEqual(DEFAULT_THRESHOLDS)
    expect(parseThresholds({ search: 'nope' })).toEqual(DEFAULT_THRESHOLDS)
  })

  it('round-trips stored thresholds', () => {
    const stored = { ...DEFAULT_THRESHOLDS, search: { haikuMax: 31, sonnetMax: 66, tunedAtSeq: 12 } }

    expect(parseThresholds(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
  })

  it('clamps and repairs malformed cutoffs', () => {
    const parsed = parseThresholds({
      search: { haikuMax: 400, sonnetMax: -3, tunedAtSeq: 'x' },
      edit: { haikuMax: 12.6 },
    })

    expect(parsed.search).toEqual({ haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 })
    expect(parsed.edit).toEqual({
      haikuMax: 13,
      sonnetMax: DEFAULT_THRESHOLDS.edit.sonnetMax,
      tunedAtSeq: 0,
    })
  })
})

describe('isRecord', () => {
  it('accepts plain objects only', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })
})

describe('savings', () => {
  it('estimates about four characters a token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts running on a cheaper tier as a saving in baseline tokens', () => {
    const [haiku, sonnet, opus] = COST_WEIGHTS

    expect(routingSavings(1000, 0, 2)).toBe(Math.round(1000 * (1 - haiku / opus)))
    expect(routingSavings(1000, 1, 2)).toBe(Math.round(1000 * (1 - sonnet / opus)))
    expect(routingSavings(1000, 2, 2)).toBe(0)
  })

  it('counts routing up as a cost', () => {
    expect(routingSavings(1000, 2, 0)).toBeLessThan(0)
  })

  it('weighs a tier above opus as opus, which can only understate', () => {
    expect(routingSavings(1000, 0, 3)).toBe(routingSavings(1000, 0, 2))
  })

  it('counts the context kept out of the main loop, never below zero', () => {
    expect(contextSavings(5000, 300)).toBe(4700)
    expect(contextSavings(100, 300)).toBe(0)
  })
})
