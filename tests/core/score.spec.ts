import { describe, expect, it } from 'vitest'

import { TASK_TYPES, isTaskType, scoreTask } from '../../src/core/score.ts'

const typeOf = (text: string): string => scoreTask({ text }).taskType

describe('task classification', () => {
  it.each([
    ['find all usages of parseConfig across the repo', 'search'],
    ['where is the retry helper defined? grep for it', 'search'],
    ['summarize the changelog and give me a recap', 'summarize'],
    ['read through every file in docs/ and gather the headings', 'bulk-read'],
    ['rename getUser to fetchUser in every file', 'repetitive-edit'],
    ['add a null check to src/api/client.ts', 'edit'],
    ['design the caching architecture and explain the trade-offs', 'reasoning'],
  ])('classifies %j as %s', (text, expected) => {
    expect(typeOf(text)).toBe(expected)
  })

  it('falls back to general for a task no pattern recognises', () => {
    expect(typeOf('hello there')).toBe('general')
    expect(typeOf('')).toBe('general')
  })

  it('breaks a tie toward the type that routes higher', () => {
    // One search hit ("find") and one reasoning hit ("why"): reasoning wins.
    expect(typeOf('find why')).toBe('reasoning')
    // One search hit and one edit hit: edit routes higher than search.
    expect(typeOf('find it and fix it')).toBe('edit')
  })

  it('is deterministic', () => {
    const text = 'refactor the scheduler and investigate the race condition'

    expect(scoreTask({ text })).toEqual(scoreTask({ text }))
  })

  it('reads the description as part of the task', () => {
    expect(scoreTask({ text: 'the helper', description: 'search usages' }).taskType).toBe('search')
  })
})

describe('features', () => {
  it('keeps every feature and the complexity in range', () => {
    const samples = [
      '',
      'x',
      'find all the things across the whole entire repo everywhere in every file recursively',
      'design architecture trade-offs why debug '.repeat(40),
      'maybe somehow improve something, clean up stuff etc',
    ]

    for (const text of samples) {
      const { features, complexity } = scoreTask({ text })

      for (const value of Object.values(features)) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }

      expect(complexity).toBeGreaterThanOrEqual(0)
      expect(complexity).toBeLessThanOrEqual(100)
    }
  })

  it('scores broad wording as wide scope', () => {
    expect(scoreTask({ text: 'update every file across the whole repo' }).features.scope).toBe(1)
    expect(scoreTask({ text: 'update src/a.ts' }).features.scope).toBe(0)
  })

  it('counts named files, and a stated file count', () => {
    const named = scoreTask({ text: 'edit src/a.ts, src/b.ts, lib/c.py and README.md' })
    const stated = scoreTask({ text: 'apply this to 40 files' })

    expect(named.features.files).toBeCloseTo(4 / 8)
    expect(stated.features.files).toBe(1)
  })

  it('assumes many files for a broad task that names none', () => {
    expect(scoreTask({ text: 'search all of the codebase everywhere' }).features.files).toBe(0.5)
  })

  it('scores reasoning words, multi-step wording and length as depth', () => {
    const shallow = scoreTask({ text: 'fix the typo in README.md' })
    const deep = scoreTask({
      text: 'investigate the deadlock, then design a fix and compare the trade-offs',
    })

    expect(shallow.features.depth).toBe(0)
    expect(deep.features.depth).toBe(1)
    expect(deep.complexity).toBeGreaterThan(shallow.complexity)
    expect(scoreTask({ text: 'word '.repeat(200) }).features.depth).toBeCloseTo(0.2)
  })

  it('scores vague and terse wording as ambiguity, and concrete anchors against it', () => {
    const vague = scoreTask({ text: 'make it better somehow' })
    const concrete = scoreTask({ text: 'make `parseConfig` in src/config.ts return a Result' })

    expect(vague.features.ambiguity).toBeGreaterThanOrEqual(0.6)
    expect(vague.isUnsure).toBe(true)
    expect(concrete.features.ambiguity).toBe(0)
    expect(concrete.isUnsure).toBe(false)
  })

  it('is unsure about a general task and about a near-empty one', () => {
    expect(scoreTask({ text: 'hello there friend' }).isUnsure).toBe(true)
    expect(scoreTask({ text: 'fix' }).isUnsure).toBe(true)
  })
})

describe('risk detection', () => {
  it.each([
    ['rotate the API key and update the auth middleware', 'security'],
    ['check how the session token is validated', 'security'],
    ['load the settings from .env', 'security'],
    ['delete the stale branches', 'destructive'],
    ['run rm -rf build and reset --hard', 'destructive'],
    ['git push --force to the feature branch', 'destructive'],
    ['write the database migration', 'destructive'],
    ['deploy the new build', 'production'],
    ['update the billing webhook', 'production'],
    ['apply the terraform change', 'production'],
  ])('flags %j as %s', (text, kind) => {
    const score = scoreTask({ text })

    expect(score.isRisky).toBe(true)
    expect(score.risks).toContain(kind)
    expect(score.features.risk).toBeGreaterThan(0)
  })

  it('does not flag ordinary mechanical work', () => {
    const score = scoreTask({ text: 'find all usages of parseConfig and list the files' })

    expect(score.isRisky).toBe(false)
    expect(score.risks).toEqual([])
    expect(score.features.risk).toBe(0)
  })

  it('reports every kind of risk a task carries', () => {
    const score = scoreTask({ text: 'delete the production password' })

    expect(score.risks).toEqual(['security', 'destructive', 'production'])
  })
})

describe('isTaskType', () => {
  it('accepts every known type and nothing else', () => {
    for (const type of TASK_TYPES) {
      expect(isTaskType(type)).toBe(true)
    }

    expect(isTaskType('poetry')).toBe(false)
    expect(isTaskType(undefined)).toBe(false)
  })
})
