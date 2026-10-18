/**
 * The trimmer's efficiency floors. `npm run bench` prints the same numbers as
 * a table; these tests fail when a change makes the trimmer save less, run
 * slower, or lose a line a person would need.
 */
import { describe, expect, it } from 'vitest'

import { trimOutput } from '../../src/core/trim.ts'
import { bigOutput, FIXTURES } from '../fixtures/outputs.ts'

/** The least each fixture must save under `full`, as a share of its tokens. */
const FLOORS: Readonly<Record<string, number>> = {
  'npm install': 0.9,
  'jest run': 0.9,
  'cargo build': 0.9,
  'docker build': 0.5,
  'server log (2.4k lines)': 0.95,
  'git diff --stat (clean)': 0,
}

/** A megabyte of output must trim well inside one tool call's patience. */
const MAX_MS_PER_MB = 400

describe('trimmer efficiency', () => {
  for (const make of FIXTURES) {
    const fixture = make()

    it(`${fixture.name}: saves at least its floor and keeps every line that matters`, () => {
      for (const level of ['full', 'lossless'] as const) {
        const result = trimOutput(fixture.text, { level, maxLines: 300 })

        for (const line of fixture.mustKeep) {
          expect(result.text.split('\n')).toContain(line)
        }

        if (level === 'full') {
          const saved = 1 - result.afterTokens / result.beforeTokens

          expect(saved).toBeGreaterThanOrEqual(FLOORS[fixture.name] ?? 0)
        }
      }
    })
  }

  it('leaves clean output byte for byte', () => {
    const clean = FIXTURES.map(make => make()).find(fixture => fixture.name.includes('clean'))

    expect(clean).toBeDefined()
    expect(trimOutput(clean?.text ?? '').text).toBe(clean?.text)
  })

  it(`trims a megabyte in under ${String(MAX_MS_PER_MB)} ms`, () => {
    const text = bigOutput()
    const started = performance.now()
    const result = trimOutput(text)
    const elapsed = performance.now() - started

    expect(result.afterTokens).toBeLessThan(result.beforeTokens / 10)
    expect(elapsed / (text.length / 1_000_000)).toBeLessThan(MAX_MS_PER_MB)
  })
})
