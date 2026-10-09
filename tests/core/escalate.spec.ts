import { describe, expect, it } from 'vitest'

import {
  CHECK_SIGNALS,
  checkResult,
  isCheckSignal,
  isUserRejection,
  planEscalation,
} from '../../src/core/escalate.ts'
import type { EscalationInput } from '../../src/core/escalate.ts'

const failed: EscalationInput = {
  signal: 'error',
  tier: 'haiku',
  attempts: 0,
  isDenied: false,
  isDryRun: false,
}

describe('checkResult', () => {
  it('passes a plain answer', () => {
    expect(checkResult({ isError: false, text: 'Found 3 usages in src/a.ts.' })).toBe('ok')
  })

  it('passes an empty-handed search: finding nothing is an answer', () => {
    expect(checkResult({ isError: false, text: 'No usages of parseConfig were found.' })).toBe('ok')
  })

  it('reports an errored call', () => {
    expect(checkResult({ isError: true, text: 'anything' })).toBe('error')
  })

  it('reports an empty answer', () => {
    expect(checkResult({ isError: false, text: '  \n ' })).toBe('empty')
  })

  it.each([
    '3 tests failed after the change',
    'Ran the suite: 2 failed, 40 passed',
    'the tests are still failing',
    'AssertionError: expected 1 to be 2',
    'FAIL src/a.test.ts',
  ])('reports failing tests in %j', text => {
    expect(checkResult({ isError: false, text })).toBe('failing-tests')
  })

  it.each([
    "I'm not sure this is the right file.",
    'I was unable to complete the rename.',
    "I couldn't determine where it is called.",
    'This is my best guess.',
    'I ran out of context before finishing.',
  ])('reports low confidence in %j', text => {
    expect(checkResult({ isError: false, text })).toBe('low-confidence')
  })
})

describe('isUserRejection', () => {
  it.each(['no, that is wrong', 'Nope', "that's not what I asked", 'revert that', 'try again', "it didn't work", 'still broken'])(
    'reads %j as a rejection',
    prompt => {
      expect(isUserRejection(prompt)).toBe(true)
    },
  )

  it.each(['now add tests', 'great, next rename it', 'notice the header', 'nothing else, thanks'])(
    'does not read %j as a rejection',
    prompt => {
      expect(isUserRejection(prompt)).toBe(false)
    },
  )
})

describe('planEscalation', () => {
  it('retries a failed result one tier up', () => {
    expect(planEscalation(failed)).toEqual({ shouldEscalate: true, to: 'sonnet' })
    expect(planEscalation({ ...failed, tier: 'sonnet' })).toEqual({ shouldEscalate: true, to: 'opus' })
  })

  it('does not retry a result that passed', () => {
    expect(planEscalation({ ...failed, signal: 'ok' }).shouldEscalate).toBe(false)
  })

  it('retries once only', () => {
    expect(planEscalation({ ...failed, attempts: 1 }).shouldEscalate).toBe(false)
  })

  it('has nowhere to go from the top tier', () => {
    expect(planEscalation({ ...failed, tier: 'opus' }).shouldEscalate).toBe(false)
  })

  it('does not retry a model tokensaver did not pick', () => {
    expect(planEscalation({ ...failed, tier: undefined }).shouldEscalate).toBe(false)
  })

  it('does not retry in a dry run', () => {
    expect(planEscalation({ ...failed, isDryRun: true }).shouldEscalate).toBe(false)
  })

  it('treats a denial as final', () => {
    const plan = planEscalation({ ...failed, isDenied: true })

    expect(plan).toEqual({ shouldEscalate: false, reason: expect.stringContaining('denied') })
  })
})

describe('isCheckSignal', () => {
  it('accepts every signal and nothing else', () => {
    for (const signal of CHECK_SIGNALS) {
      expect(isCheckSignal(signal)).toBe(true)
    }

    expect(isCheckSignal('fine')).toBe(false)
  })
})
