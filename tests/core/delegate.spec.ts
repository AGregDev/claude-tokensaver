import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MIN_SAVING,
  MIN_SAVING_CEILING,
  MIN_SAVING_FLOOR,
  SPAWN_OVERHEAD_TOKENS,
  TOKENS_PER_FILE,
  decideDelegation,
  estimateFiles,
  judgeHint,
  parseMinSaving,
  tuneMinSaving,
} from '../../src/core/delegate.ts'
import type { DelegationFacts } from '../../src/core/delegate.ts'
import { scoreTask } from '../../src/core/score.ts'
import { SEARCH_PROMPT } from '../helpers.ts'

const OPUS_RANK = 2
const SONNET_RANK = 1
const HAIKU_RANK = 0

const facts = (extra: Partial<DelegationFacts> = {}): DelegationFacts => ({
  repoFiles: 400,
  parentRank: OPUS_RANK,
  minSaving: DEFAULT_MIN_SAVING,
  ...extra,
})

const BULK_READ = 'read through every file in the whole repo and gather the open questions'

describe('estimateFiles', () => {
  it('counts the files a task names', () => {
    const score = scoreTask({ text: 'read src/a.ts, src/b.ts and lib/c.py and gather the exports' })

    expect(estimateFiles(score, 400)).toBe(3)
  })

  it('takes a stated file count', () => {
    expect(estimateFiles(scoreTask({ text: 'scan these 25 files for TODOs' }), 400)).toBe(25)
  })

  it('takes a share of the repository for a broad task, larger for reading than for searching', () => {
    const search = estimateFiles(scoreTask({ text: SEARCH_PROMPT }), 400)
    const reading = estimateFiles(scoreTask({ text: BULK_READ }), 400)

    expect(search).toBe(32)
    expect(reading).toBe(60)
    expect(reading).toBeGreaterThan(search)
  })

  it('scales with the repository, and never assumes more than its ceiling', () => {
    const score = scoreTask({ text: SEARCH_PROMPT })

    expect(estimateFiles(score, 40)).toBe(3)
    expect(estimateFiles(score, 100_000)).toBe(60)
  })

  it('assumes a mid-sized repository when the size is unknown', () => {
    expect(estimateFiles(scoreTask({ text: SEARCH_PROMPT }), undefined)).toBe(8)
  })

  it('assumes nothing for a narrow task that names no file', () => {
    expect(estimateFiles(scoreTask({ text: 'find the retry helper' }), 400)).toBe(0)
  })
})

describe('decideDelegation', () => {
  it('suggests delegating broad reading in a large repository', () => {
    const decision = decideDelegation(scoreTask({ text: SEARCH_PROMPT }), facts())

    expect(decision.shouldDelegate).toBe(true)
    expect(decision.estimatedFiles).toBe(32)
    expect(decision.estimatedSaving).toBeGreaterThan(DEFAULT_MIN_SAVING)
    expect(decision.agents).toBe(2)
  })

  it('keeps the same task inline in a small repository: a sub-agent costs more to start than it saves', () => {
    const decision = decideDelegation(scoreTask({ text: SEARCH_PROMPT }), facts({ repoFiles: 40 }))

    expect(decision.shouldDelegate).toBe(false)
    expect(decision.reason).toContain('cost more')
    expect(3 * TOKENS_PER_FILE).toBeLessThan(SPAWN_OVERHEAD_TOKENS / 5)
  })

  it('needs more reading to pay off under a cheaper session model', () => {
    const score = scoreTask({ text: 'read these 5 files and summarize what each one does' })

    expect(decideDelegation(score, facts({ parentRank: OPUS_RANK })).shouldDelegate).toBe(true)
    expect(decideDelegation(score, facts({ parentRank: SONNET_RANK })).shouldDelegate).toBe(false)
  })

  it('from the cheapest model, suggests it only for reading heavy enough to be worth keeping out of context', () => {
    // Nothing is cheaper to hand the work to, so the only gain is what the main context never carries.
    const modest = scoreTask({ text: 'read these 8 files and summarize what each one does' })
    const heavy = scoreTask({ text: 'scan these 60 files and gather every TODO' })

    expect(decideDelegation(modest, facts({ parentRank: OPUS_RANK })).shouldDelegate).toBe(true)
    expect(decideDelegation(modest, facts({ parentRank: HAIKU_RANK })).shouldDelegate).toBe(false)
    expect(decideDelegation(heavy, facts({ parentRank: HAIKU_RANK })).shouldDelegate).toBe(true)
  })

  it('splits heavy reading across up to three sub-agents, and light reading across one', () => {
    const light = decideDelegation(scoreTask({ text: 'read these 10 files and summarize them' }), facts())
    const heavy = decideDelegation(scoreTask({ text: BULK_READ }), facts({ repoFiles: 5000 }))

    expect(light.agents).toBe(1)
    expect(heavy.agents).toBe(2)
    expect(decideDelegation(scoreTask({ text: SEARCH_PROMPT }), facts({ repoFiles: 100_000 })).agents).toBeLessThanOrEqual(3)
  })

  it('keeps reasoning and edits inline', () => {
    for (const text of ['design the plugin architecture across the whole repo', 'add a null check to src/a.ts']) {
      const decision = decideDelegation(scoreTask({ text }), facts())

      expect(decision.shouldDelegate).toBe(false)
      expect(decision.reason).toContain('not a delegable')
    }
  })

  it('keeps risky work in the main loop however much reading it means', () => {
    const decision = decideDelegation(
      scoreTask({ text: 'find every password across the whole repo and list all files' }),
      facts({ repoFiles: 100_000 }),
    )

    expect(decision.shouldDelegate).toBe(false)
    expect(decision.reason).toContain('risky')
  })

  it('suggests nothing under a session model it cannot compare', () => {
    const decision = decideDelegation(scoreTask({ text: BULK_READ }), facts({ parentRank: undefined }))

    expect(decision.shouldDelegate).toBe(false)
  })

  it('suggests less as the bar rises', () => {
    const score = scoreTask({ text: 'read these 8 files and summarize what each one does' })
    const saving = decideDelegation(score, facts()).estimatedSaving

    expect(decideDelegation(score, facts({ minSaving: saving })).shouldDelegate).toBe(true)
    expect(decideDelegation(score, facts({ minSaving: saving + 1 })).shouldDelegate).toBe(false)
  })
})

describe('judging a suggestion', () => {
  it('paid off when a sub-agent did real work beyond its start-up', () => {
    expect(judgeHint({ largestAgentTokens: 90_000, mainReads: 0 })).toBe('paid-off')
  })

  it('over-fired when the sub-agent barely did more than start', () => {
    expect(judgeHint({ largestAgentTokens: 32_000, mainReads: 0 })).toBe('over-fired')
  })

  it('over-fired when Claude declined and then read little', () => {
    expect(judgeHint({ largestAgentTokens: 0, mainReads: 1 })).toBe('over-fired')
  })

  it('is unclear when Claude declined and read a lot itself', () => {
    expect(judgeHint({ largestAgentTokens: 0, mainReads: 12 })).toBe('unclear')
  })
})

describe('tuning the bar', () => {
  it('raises the bar at once when a suggestion over-fired, and lowers it slowly when one paid off', () => {
    const raised = tuneMinSaving(DEFAULT_MIN_SAVING, 'over-fired')
    const lowered = tuneMinSaving(DEFAULT_MIN_SAVING, 'paid-off')

    expect(raised).toBe(5000)
    expect(lowered).toBe(3880)
    expect(raised - DEFAULT_MIN_SAVING).toBeGreaterThan(DEFAULT_MIN_SAVING - lowered)
    expect(tuneMinSaving(DEFAULT_MIN_SAVING, 'unclear')).toBe(DEFAULT_MIN_SAVING)
  })

  it('stays within its floor and ceiling', () => {
    let bar = DEFAULT_MIN_SAVING

    for (let round = 0; round < 200; round += 1) {
      bar = tuneMinSaving(bar, 'over-fired')
    }

    expect(bar).toBe(MIN_SAVING_CEILING)

    for (let round = 0; round < 400; round += 1) {
      bar = tuneMinSaving(bar, 'paid-off')
    }

    expect(bar).toBe(MIN_SAVING_FLOOR)
  })

  it('reads a stored bar and repairs a bad one', () => {
    expect(parseMinSaving({ minSaving: 9000 })).toBe(9000)
    expect(parseMinSaving({ minSaving: 1 })).toBe(MIN_SAVING_FLOOR)
    expect(parseMinSaving({ minSaving: 1e12 })).toBe(MIN_SAVING_CEILING)
    expect(parseMinSaving({ minSaving: 'lots' })).toBe(DEFAULT_MIN_SAVING)
    expect(parseMinSaving(undefined)).toBe(DEFAULT_MIN_SAVING)
    expect(parseMinSaving('junk')).toBe(DEFAULT_MIN_SAVING)
  })
})
