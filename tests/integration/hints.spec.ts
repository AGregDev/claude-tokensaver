/**
 * Suggesting delegation, and learning from what Claude then did with the
 * suggestion. tokensaver only ever suggests: it never starts a sub-agent.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_MIN_SAVING } from '../../src/core/delegate.ts'
import {
  FLASH_MS,
  hasFreshFlash,
  isAnimating,
  onCommand,
  onDiagnostic,
  onFacts,
  onPrompt,
  onStepUsage,
  onTick,
  onTurnComplete,
} from '../../src/runtime/session.ts'
import type { Session } from '../../src/runtime/session.ts'
import { HAIKU, OPUS, SEARCH_PROMPT, SONNET, Stream, freshSession, startSession } from '../helpers.ts'

const prompt = (stream: Stream, text: string, now = 1000): string | undefined =>
  stream.apply(onPrompt(stream.session, { text, isFromUser: true, now })).context

const endMainTurn = (stream: Stream, extra: { isAborted?: boolean } = {}): void => {
  stream.apply(
    onTurnComplete(stream.session, {
      turnId: 'main-turn',
      agentId: undefined,
      usage: undefined,
      isFailed: false,
      isAborted: extra.isAborted === true,
      answer: 'done',
      now: 2000,
    }),
  )
}

const mainStep = (stream: Stream, reads: number): void => {
  stream.apply(
    onStepUsage(stream.session, {
      turnId: 'main-turn',
      agentId: undefined,
      usage: { model: OPUS, input: 100, output: 10, cacheWrite: 0 },
      reads,
    }),
  )
}

describe('the suggestion', () => {
  it('is directive, sized, and leaves Claude a way out', () => {
    const hint = prompt(new Stream(startSession()), SEARCH_PROMPT) ?? ''

    expect(hint).toMatch(/^\[tokensaver\] /)
    expect(hint).toContain('about 32 files')
    expect(hint).toContain('up to 2 Explore sub-agents in parallel')
    expect(hint).toContain('Agent tool')
    expect(hint).toContain('Skip this only if')
    expect(hint.length).toBeLessThan(400)
  })

  it('names one sub-agent for lighter reading', () => {
    const hint = prompt(new Stream(startSession()), 'read these 10 files and summarize them') ?? ''

    expect(hint).toContain('one Explore sub-agent')
    expect(hint).not.toContain('parallel')
  })

  it('is not made in a small repository, where a sub-agent costs more to start than it saves', () => {
    const stream = new Stream({ ...startSession(), facts: { repoFiles: 40, model: OPUS } })

    expect(prompt(stream, SEARCH_PROMPT)).toBeUndefined()
    expect(stream.session.saved).toBe(0)
    expect(stream.session.isHintActive).toBe(false)
  })

  it('is not made before the session model is known', () => {
    expect(prompt(new Stream(freshSession()), SEARCH_PROMPT)).toBeUndefined()
  })

  it('depends on the session model', () => {
    const task = 'read these 5 files and summarize what each one does'
    const under = (model: string): string | undefined =>
      prompt(new Stream({ ...startSession(), facts: { repoFiles: 400, model } }), task)

    expect(under(OPUS)).toBeDefined()
    expect(under(SONNET)).toBeUndefined()
    expect(under(HAIKU)).toBeUndefined()
  })

  it('takes the facts the display layer learns, one at a time', () => {
    const stream = new Stream(freshSession())

    stream.apply(onFacts(stream.session, { model: OPUS }))
    stream.apply(onFacts(stream.session, { repoFiles: 900 }))

    expect(stream.session.facts).toEqual({ model: OPUS, repoFiles: 900 })
    expect(prompt(stream, SEARCH_PROMPT)).toBeDefined()
  })
})

describe('learning from what happened to a suggestion', () => {
  const hinted = (): Stream => {
    const stream = new Stream(startSession())

    expect(prompt(stream, SEARCH_PROMPT)).toBeDefined()

    return stream
  }

  it('raises the bar when Claude declined and then read little: the task was small', () => {
    const stream = hinted()

    mainStep(stream, 1)
    endMainTurn(stream)

    expect(stream.session.minSaving).toBeGreaterThan(DEFAULT_MIN_SAVING)
    expect(stream.session.isHintActive).toBe(false)
    expect(stream.session.notes.at(-1)).toContain('raising the bar')
    expect(stream.kinds()).toContain('save-log')
  })

  it('leaves the bar alone when Claude declined but read a lot itself', () => {
    const stream = hinted()

    mainStep(stream, 5)
    mainStep(stream, 6)
    endMainTurn(stream)

    expect(stream.session.mainReads).toBe(11)
    expect(stream.session.minSaving).toBe(DEFAULT_MIN_SAVING)
  })

  it('lowers the bar a little when the sub-agent did real work', () => {
    const stream = hinted()

    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'Found 14.' }], tokens: 80_000 })
    endMainTurn(stream)

    expect(stream.session.minSaving).toBeLessThan(DEFAULT_MIN_SAVING)
    expect(stream.session.notes.at(-1)).toContain('paid off')
  })

  it('raises the bar when the sub-agent barely did more than start', () => {
    const stream = hinted()

    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'Found 1.' }], tokens: 31_000 })
    endMainTurn(stream)

    expect(stream.session.minSaving).toBeGreaterThan(DEFAULT_MIN_SAVING)
  })

  it('judges a suggestion once, and not at all for a turn the user interrupted', () => {
    const once = hinted()

    mainStep(once, 0)
    endMainTurn(once)

    const raised = once.session.minSaving

    endMainTurn(once)
    expect(once.session.minSaving).toBe(raised)

    const interrupted = hinted()

    endMainTurn(interrupted, { isAborted: true })
    expect(interrupted.session.minSaving).toBe(DEFAULT_MIN_SAVING)
  })

  it('does not count what a sub-agent reads as the main loop reading', () => {
    const stream = hinted()

    stream.apply(
      onStepUsage(stream.session, {
        turnId: 't',
        agentId: 'agent-9',
        usage: { model: HAIKU, input: 100, output: 10, cacheWrite: 0 },
        reads: 20,
      }),
    )

    expect(stream.session.mainReads).toBe(0)
  })

  it('starts each turn counting from zero', () => {
    const stream = hinted()

    mainStep(stream, 7)
    prompt(stream, 'thanks')

    expect(stream.session.mainReads).toBe(0)
  })

  it('keeps the learned bar across sessions, and resets it with the log', () => {
    const kept = startSession({}, { delegation: { minSaving: 9000 } })

    expect(kept.minSaving).toBe(9000)

    const stream = new Stream(kept)

    stream.apply(onCommand(stream.session, 'reset', 1))
    expect(stream.session.minSaving).toBe(DEFAULT_MIN_SAVING)
  })
})

describe('events shown above the prompt', () => {
  const withAgent = (results: readonly { text: string; isError?: boolean }[]): Stream => {
    const stream = new Stream(startSession())

    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results })

    return stream
  }

  it('flashes when a sub-agent settles, with what it cost and where it ran', () => {
    const { session } = withAgent([{ text: 'Found 14.' }])

    expect(session.flash).toMatchObject({ tone: 'done' })
    expect(session.flash?.text).toMatch(/done · 4\.2k on haiku$/)
  })

  it('flashes a failure in its own tone', () => {
    const { session } = withAgent([{ text: '', isError: true }, { text: '2 tests failed' }])

    expect(session.flash).toMatchObject({ tone: 'fail' })
    expect(session.flash?.text).toContain('failed (failing tests)')
  })

  it('flashes the suggestion itself', () => {
    const stream = new Stream(startSession())

    prompt(stream, SEARCH_PROMPT, 5000)

    expect(stream.session.flash).toEqual({
      text: 'suggested delegating about 32 files of reading',
      tone: 'info',
      at: 5000,
    })
  })

  it('stays fresh for a few seconds, kept alive by the clock, then goes', () => {
    let session: Session = { ...startSession({ reducedMotion: true }), flash: { text: 'x', tone: 'done', at: 1000 }, now: 1000 }

    expect(hasFreshFlash(session)).toBe(true)
    // Even under reduced motion the clock must run, or the event would never be taken down.
    expect(isAnimating(session)).toBe(true)

    session = onTick(session, 1000 + FLASH_MS - 1).session
    expect(hasFreshFlash(session)).toBe(true)

    session = onTick(session, 1000 + FLASH_MS).session
    expect(hasFreshFlash(session)).toBe(false)
    expect(isAnimating(session)).toBe(false)
  })

  it('never animates while tokensaver is off', () => {
    const session: Session = { ...startSession({ enabled: false }), flash: { text: 'x', tone: 'done', at: 1 }, now: 1 }

    expect(isAnimating(session)).toBe(false)
  })
})

describe('/tokensaver doctor', () => {
  it('reports what tokensaver knows and what the display told it', () => {
    const stream = new Stream(startSession())

    stream.apply(onDiagnostic(stream.session, 'desktop attached'))
    stream.apply(onDiagnostic(stream.session, 'pane opened (asked)'))

    const { text } = stream.apply(onCommand(stream.session, 'doctor', 1))

    expect(text).toContain('tokensaver is on')
    expect(text).toContain(`session model: ${OPUS}`)
    expect(text).toContain('about 400 files')
    expect(text).toContain('general-purpose inherits')
    expect(text).toContain('must save at least 4.0k tokens')
    expect(text).toContain('colour on, motion on')
    expect(text).toContain('  desktop attached\n  pane opened (asked)')
  })

  it('says what it does not know yet', () => {
    const { text } = new Stream(freshSession()).apply(onCommand(freshSession({ reducedMotion: true }), 'doctor', 1))

    expect(text).toContain('session model: not reported yet')
    expect(text).toContain('repository: not counted yet')
    expect(text).toContain('agent types seen: none yet')
    expect(text).toContain('motion off')
    expect(text).toContain('nothing reported yet')
  })

  it('names a type that brings its own model, and keeps only the newest reports', () => {
    let session: Session = { ...startSession(), agentTypes: { architect: 'own-model' }, hasNoColor: true }

    for (let index = 0; index < 30; index += 1) {
      session = onDiagnostic(session, `line ${String(index)}`).session
    }

    const { text } = onCommand(session, 'doctor', 1).reply

    expect(text).toContain('architect has its own model')
    expect(text).toContain('colour off (NO_COLOR)')
    expect(text).toContain('line 29')
    expect(text).not.toContain('line 5\n')
    expect(session.diagnostics).toHaveLength(12)
  })
})
