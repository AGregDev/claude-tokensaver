import { describe, expect, it } from 'vitest'

import { appendOutcome, parseLog } from '../../src/core/log.ts'
import { DEFAULT_THRESHOLDS } from '../../src/core/route.ts'
import { TASK_TYPES } from '../../src/core/score.ts'
import { TUNING, learnFromOutcome, tighten, tuneFromLog } from '../../src/core/tune.ts'
import { cleanRun, outcome } from '../helpers.ts'

describe('tighten', () => {
  it('lowers the haiku cutoff at once after a failure on haiku', () => {
    const tightened = tighten(DEFAULT_THRESHOLDS, 'search', 'haiku', 7)

    expect(tightened.search.haikuMax).toBe(DEFAULT_THRESHOLDS.search.haikuMax - TUNING.tightenStep)
    expect(tightened.search.sonnetMax).toBe(DEFAULT_THRESHOLDS.search.sonnetMax)
    expect(tightened.search.tunedAtSeq).toBe(7)
  })

  it('lowers the sonnet cutoff after a failure on sonnet', () => {
    const tightened = tighten(DEFAULT_THRESHOLDS, 'edit', 'sonnet', 3)

    expect(tightened.edit.sonnetMax).toBe(DEFAULT_THRESHOLDS.edit.sonnetMax - TUNING.tightenStep)
    expect(tightened.edit.haikuMax).toBe(DEFAULT_THRESHOLDS.edit.haikuMax)
  })

  it('leaves other task types alone', () => {
    const tightened = tighten(DEFAULT_THRESHOLDS, 'search', 'haiku', 1)

    for (const type of TASK_TYPES.filter(type => type !== 'search')) {
      expect(tightened[type]).toEqual(DEFAULT_THRESHOLDS[type])
    }
  })

  it('never goes below zero or crosses the cutoffs', () => {
    let thresholds = DEFAULT_THRESHOLDS

    for (let round = 0; round < 30; round += 1) {
      thresholds = tighten(thresholds, 'reasoning', 'haiku', round)
      thresholds = tighten(thresholds, 'reasoning', 'sonnet', round)
    }

    expect(thresholds.reasoning.haikuMax).toBe(0)
    expect(thresholds.reasoning.sonnetMax).toBe(0)
    expect(thresholds.reasoning.sonnetMax).toBeGreaterThanOrEqual(thresholds.reasoning.haikuMax)
  })

  it('has no cheaper rule to tighten after a failure on opus', () => {
    const tightened = tighten(DEFAULT_THRESHOLDS, 'search', 'opus', 9)

    expect(tightened.search).toEqual({ ...DEFAULT_THRESHOLDS.search, tunedAtSeq: 9 })
  })
})

describe('tuneFromLog', () => {
  it('changes nothing for an empty log', () => {
    expect(tuneFromLog(DEFAULT_THRESHOLDS, [])).toEqual(DEFAULT_THRESHOLDS)
  })

  it('changes nothing for a corrupted log', () => {
    const { outcomes } = parseLog('{"not":"a list"')

    expect(tuneFromLog(DEFAULT_THRESHOLDS, outcomes)).toEqual(DEFAULT_THRESHOLDS)
  })

  it('does not loosen on too little evidence', () => {
    const log = cleanRun(TUNING.minSamples - 1, 'search', 'haiku')

    expect(tuneFromLog(DEFAULT_THRESHOLDS, log)).toEqual(DEFAULT_THRESHOLDS)
  })

  it('loosens by a small step once the evidence is clean and sufficient', () => {
    const log = cleanRun(TUNING.minSamples, 'search', 'haiku')
    const tuned = tuneFromLog(DEFAULT_THRESHOLDS, log)

    expect(tuned.search.haikuMax).toBe(DEFAULT_THRESHOLDS.search.haikuMax + TUNING.loosenStep)
    expect(tuned.search.sonnetMax).toBe(DEFAULT_THRESHOLDS.search.sonnetMax)
    expect(tuned.search.tunedAtSeq).toBe(TUNING.minSamples)
    expect(TUNING.loosenStep).toBeLessThan(TUNING.tightenStep)
  })

  it('loosens the sonnet cutoff from clean sonnet runs', () => {
    const tuned = tuneFromLog(DEFAULT_THRESHOLDS, cleanRun(TUNING.minSamples, 'edit', 'sonnet'))

    expect(tuned.edit.sonnetMax).toBe(DEFAULT_THRESHOLDS.edit.sonnetMax + TUNING.loosenStep)
    expect(tuned.edit.haikuMax).toBe(DEFAULT_THRESHOLDS.edit.haikuMax)
  })

  it.each([
    ['a failure', { isSuccess: false, signal: 'error' } as const],
    ['an escalation', { wasEscalated: true } as const],
    ['a retry', { retries: 1 } as const],
  ])('does not loosen when the window holds %s', (_name, flaw) => {
    const log = [
      ...cleanRun(TUNING.minSamples + 5, 'search', 'haiku'),
      outcome({ seq: 99, taskType: 'search', tier: 'haiku', ...flaw }),
    ]

    expect(tuneFromLog(DEFAULT_THRESHOLDS, log).search).toEqual(DEFAULT_THRESHOLDS.search)
  })

  it('lets a failure on any tier block loosening for the whole task type', () => {
    const log = [
      ...cleanRun(TUNING.minSamples, 'search', 'haiku'),
      outcome({ seq: 50, taskType: 'search', tier: 'sonnet', isSuccess: false, signal: 'error' }),
    ]

    expect(tuneFromLog(DEFAULT_THRESHOLDS, log).search).toEqual(DEFAULT_THRESHOLDS.search)
  })

  it('does not let one task type speak for another', () => {
    const tuned = tuneFromLog(DEFAULT_THRESHOLDS, cleanRun(TUNING.minSamples, 'search', 'haiku'))

    expect(tuned.edit).toEqual(DEFAULT_THRESHOLDS.edit)
    expect(tuned.reasoning).toEqual(DEFAULT_THRESHOLDS.reasoning)
  })

  it('spends evidence: the same clean run cannot loosen twice', () => {
    const log = cleanRun(TUNING.minSamples, 'search', 'haiku')
    const once = tuneFromLog(DEFAULT_THRESHOLDS, log)
    const twice = tuneFromLog(once, log)

    expect(twice).toEqual(once)
  })

  it('ignores evidence from before the last tightening', () => {
    const log = cleanRun(TUNING.minSamples, 'search', 'haiku')
    const tightened = tighten(DEFAULT_THRESHOLDS, 'search', 'haiku', TUNING.minSamples)

    expect(tuneFromLog(tightened, log)).toEqual(tightened)
  })

  it('never drifts further than the cap above the defaults', () => {
    let thresholds = DEFAULT_THRESHOLDS
    let log = cleanRun(0, 'search', 'haiku')

    for (let round = 0; round < 40; round += 1) {
      for (const fresh of cleanRun(TUNING.minSamples, 'search', 'haiku', log.length + 1)) {
        log = [...appendOutcome(log, fresh)]
      }

      thresholds = tuneFromLog(thresholds, log)
    }

    expect(thresholds.search.haikuMax).toBe(DEFAULT_THRESHOLDS.search.haikuMax + TUNING.maxDrift)
    expect(thresholds.search.haikuMax).toBeLessThanOrEqual(
      thresholds.search.sonnetMax - TUNING.minGap,
    )
  })

  it('treats a tie at exactly the sample minimum as enough, and one short as not', () => {
    const exact = tuneFromLog(DEFAULT_THRESHOLDS, cleanRun(TUNING.minSamples, 'summarize', 'haiku'))
    const short = tuneFromLog(DEFAULT_THRESHOLDS, cleanRun(TUNING.minSamples - 1, 'summarize', 'haiku'))

    expect(exact.summarize.haikuMax).toBeGreaterThan(DEFAULT_THRESHOLDS.summarize.haikuMax)
    expect(short.summarize).toEqual(DEFAULT_THRESHOLDS.summarize)
  })
})

describe('learnFromOutcome', () => {
  it('tightens immediately on a failure', () => {
    const failure = outcome({ seq: 1, isSuccess: false, signal: 'failing-tests' })
    const learned = learnFromOutcome(DEFAULT_THRESHOLDS, [failure], failure)

    expect(learned.search.haikuMax).toBeLessThan(DEFAULT_THRESHOLDS.search.haikuMax)
  })

  it('tightens immediately on an escalation, even one that ended well', () => {
    const escalated = outcome({ seq: 1, tier: 'sonnet', wasEscalated: true, retries: 1 })
    const learned = learnFromOutcome(DEFAULT_THRESHOLDS, [escalated], escalated)

    expect(learned.search.sonnetMax).toBeLessThan(DEFAULT_THRESHOLDS.search.sonnetMax)
  })

  it('runs a loosening pass only every tuneEvery outcomes', () => {
    const log = cleanRun(TUNING.minSamples + TUNING.tuneEvery, 'search', 'haiku')
    const between = log.find(entry => entry.seq % TUNING.tuneEvery !== 0 && entry.seq > TUNING.minSamples)
    const onTheMark = log.find(entry => entry.seq % TUNING.tuneEvery === 0 && entry.seq > TUNING.minSamples)

    expect(between).toBeDefined()
    expect(onTheMark).toBeDefined()

    if (between !== undefined && onTheMark !== undefined) {
      expect(learnFromOutcome(DEFAULT_THRESHOLDS, log, between)).toEqual(DEFAULT_THRESHOLDS)
      expect(learnFromOutcome(DEFAULT_THRESHOLDS, log, onTheMark).search.haikuMax).toBeGreaterThan(
        DEFAULT_THRESHOLDS.search.haikuMax,
      )
    }
  })
})
