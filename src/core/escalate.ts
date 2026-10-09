import { nextTierUp } from './tiers.ts'
import type { Tier } from './tiers.ts'

export const CHECK_SIGNALS = [
  'ok',
  'error',
  'failing-tests',
  'low-confidence',
  'empty',
  'refusal',
  'user-rejection',
] as const

/** What the checks made of a sub-agent's result. Anything but `ok` is a failure. */
export type CheckSignal = (typeof CHECK_SIGNALS)[number]

export const isCheckSignal = (value: unknown): value is CheckSignal =>
  CHECK_SIGNALS.some(signal => signal === value)

const FAILING_TESTS_PATTERN =
  /\b\d+\s+(?:tests?\s+)?fail(?:ed|ing|ures?)\b|\btests?\s+(?:are\s+)?(?:still\s+)?fail(?:ed|ing)\b|\bAssertionError\b|^\s*FAIL\b/im

/**
 * Explicit statements of doubt or of not finishing. "Found nothing" is not
 * here on purpose: an empty search result is a valid answer, not a failure.
 */
const LOW_CONFIDENCE_PATTERN =
  /\b(?:i(?:'m| am) not (?:sure|certain|confident)|not confident|i (?:may|might) be wrong|(?:unable|was not able|wasn't able) to (?:complete|finish|determine)|could(?: not|n't) (?:complete|finish|determine)|ran out of (?:time|context|turns)|gave up|incomplete|best guess)\b/i

const REJECTION_PATTERN =
  /^\s*(?:no\b|nope\b|wrong\b|incorrect\b|that(?:'s| is| was)? (?:wrong|not right|incorrect|not what)|not what i|this is wrong|undo\b|revert\b|try again\b|redo\b|(?:it|that|this) (?:didn'?t|doesn'?t|did not|does not) work|still (?:broken|failing|wrong|not working))/i

export type ResultCheck = {
  isError: boolean
  text: string
}

/** Runs the deterministic checks over a sub-agent's result. */
export const checkResult = ({ isError, text }: ResultCheck): CheckSignal => {
  if (isError) {
    return 'error'
  }

  if (text.trim() === '') {
    return 'empty'
  }

  if (FAILING_TESTS_PATTERN.test(text)) {
    return 'failing-tests'
  }

  return LOW_CONFIDENCE_PATTERN.test(text) ? 'low-confidence' : 'ok'
}

/** True when the user's next prompt opens by rejecting the previous result. */
export const isUserRejection = (prompt: string): boolean => REJECTION_PATTERN.test(prompt)

export type EscalationInput = {
  signal: CheckSignal
  /** The tier the failed attempt ran on; undefined when tokensaver did not pick it. */
  tier: Tier | undefined
  /** Retries already spent on this task. */
  attempts: number
  isDenied: boolean
  isDryRun: boolean
}

export type EscalationPlan =
  | { shouldEscalate: true; to: Tier }
  | { shouldEscalate: false; reason: string }

/** The most retries one task gets: escalation is one step up, once. */
export const MAX_RETRIES = 1

/**
 * Decides whether a failed result is retried one tier up. The answer is
 * either a strictly higher tier or no retry at all: it never moves down.
 */
export const planEscalation = (input: EscalationInput): EscalationPlan => {
  if (input.isDenied) {
    return { shouldEscalate: false, reason: 'the call was denied, and a denial is final' }
  }

  if (input.signal === 'ok') {
    return { shouldEscalate: false, reason: 'the result passed its checks' }
  }

  if (input.isDryRun) {
    return { shouldEscalate: false, reason: 'dry run' }
  }

  if (input.tier === undefined) {
    return { shouldEscalate: false, reason: 'tokensaver did not pick this model' }
  }

  if (input.attempts >= MAX_RETRIES) {
    return { shouldEscalate: false, reason: 'already retried once' }
  }

  const to = nextTierUp(input.tier)

  return to === undefined
    ? { shouldEscalate: false, reason: 'already on the top tier' }
    : { shouldEscalate: true, to }
}
