/**
 * End-to-end flows over a mocked event stream: the events Claude Code raises,
 * in order, played through the controller exactly as hooks/register.tsx does.
 */
import { describe, expect, it } from 'vitest'

import { DEFAULT_THRESHOLDS } from '../../src/core/route.ts'
import { TUNING } from '../../src/core/tune.ts'
import {
  activeCount,
  hydrate,
  isAnimating,
  onAgentResult,
  onCommand,
  onMeasure,
  onPrompt,
  onSpawn,
  onSpawned,
  onStepUsage,
  onTick,
  onTurnComplete,
} from '../../src/runtime/session.ts'
import type { SpawnInput } from '../../src/runtime/session.ts'
import { HAIKU, OPUS, RISKY_PROMPT, SEARCH_PROMPT, Stream, cleanRun, outcome, startSession } from '../helpers.ts'

const prompt = (stream: Stream, text: string, isFromUser = true): string | undefined =>
  stream.apply(onPrompt(stream.session, { text, isFromUser, now: 5 })).context

const spawnInput = (extra: Partial<SpawnInput> = {}): SpawnInput => ({
  toolUseId: 'call-1',
  prompt: SEARCH_PROMPT,
  description: '',
  subagentType: 'general-purpose',
  explicitModel: undefined,
  parentModel: OPUS,
  parentAgentId: undefined,
  isBackground: false,
  isPinned: false,
  ...extra,
})

describe('delegation', () => {
  it('hints, routes, meters, logs and counts the saving for a broad search', () => {
    const stream = new Stream(startSession())
    const hint = prompt(stream, SEARCH_PROMPT)

    expect(hint).toContain('[tokensaver]')
    expect(hint).toContain('sub-agent')

    const { models, attempts } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: 'Found 14 usages in 6 files.' }],
      tokens: 8000,
    })

    expect(models).toEqual(['haiku'])
    expect(attempts).toBe(1)
    expect(stream.toasts()).toEqual([expect.stringContaining('→ haiku (search)')])
    expect(stream.session.spend.haiku).toBe(8200)
    expect(stream.session.spend.opus).toBe(0)
    expect(stream.session.agents[0]).toMatchObject({ status: 'done', tier: 'haiku', tokens: 8200 })
    expect(stream.session.outcomes).toEqual([
      expect.objectContaining({ taskType: 'search', tier: 'haiku', isSuccess: true, retries: 0, wasEscalated: false }),
    ])
    // Routing: 8200 tokens on haiku instead of opus, less the hint. Context: the work less its summary.
    expect(stream.session.saved).toBeGreaterThan(6000)
    expect(stream.session.saved).toBeLessThan(8200 * 0.8)
    expect(stream.session.keptOut).toBeGreaterThan(8000)
    expect(stream.session.keptOut).toBeLessThanOrEqual(8200)
    expect(stream.kinds()).toContain('save-log')
  })

  it('keeps a small or reasoning-heavy task inline and adds nothing to the prompt', () => {
    const stream = new Stream(startSession())

    expect(prompt(stream, 'fix the typo in README.md')).toBeUndefined()
    expect(prompt(stream, 'design the plugin architecture and weigh the trade-offs')).toBeUndefined()
    expect(stream.effects).toEqual([])
    expect(stream.session.saved).toBe(0)
  })

  it('charges its own hint against the savings', () => {
    const stream = new Stream(startSession())

    prompt(stream, SEARCH_PROMPT)

    expect(stream.session.saved).toBeLessThan(0)
  })

  it('does not score a prompt the user did not type', () => {
    const stream = new Stream(startSession())

    expect(prompt(stream, SEARCH_PROMPT, false)).toBeUndefined()
  })

  it('leaves the hint out when the option is off, and still routes', () => {
    const stream = new Stream(startSession({ contextHint: false }))

    expect(prompt(stream, SEARCH_PROMPT)).toBeUndefined()
    expect(stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] }).models).toEqual(['haiku'])
  })

  it('routes a risky sub-agent nowhere cheaper and logs nothing it did not decide', () => {
    const stream = new Stream(startSession())
    const { models } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: RISKY_PROMPT,
      results: [{ text: 'done' }],
    })

    expect(models).toEqual([undefined])
    expect(stream.session.outcomes).toEqual([])
    expect(stream.toasts()).toEqual([])
  })

  it('tracks a sub-agent of a sub-agent under its parent', () => {
    const stream = new Stream(startSession())

    stream.apply(onSpawn(stream.session, spawnInput()))
    stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: 'agent-1', isDenied: false }))
    stream.apply(onSpawn(stream.session, spawnInput({ toolUseId: 'call-2', parentAgentId: 'agent-1' })))

    expect(stream.session.agents.map(agent => agent.parentAgentId)).toEqual([undefined, 'agent-1'])
    expect(activeCount(stream.session)).toBe(2)
  })
})

describe('escalation', () => {
  it('retries once on the next tier up and records it', () => {
    const stream = new Stream(startSession())
    const { models, attempts } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: 'I was unable to complete the search.' }, { text: 'Found 14 usages.' }],
    })

    expect(models).toEqual(['haiku', 'sonnet'])
    expect(attempts).toBe(2)
    expect(stream.toasts()).toEqual([
      expect.stringContaining('→ haiku'),
      expect.stringContaining('failed on haiku (low confidence), retrying on sonnet'),
      expect.stringContaining('escalated'),
    ])
    expect(stream.session.outcomes).toEqual([
      expect.objectContaining({ tier: 'sonnet', retries: 1, wasEscalated: true, isSuccess: true }),
    ])
    expect(stream.session.agents[0]).toMatchObject({ status: 'done', tier: 'sonnet', escalatedFrom: 'haiku' })
  })

  it('tightens the failed tier at once, before the retry finishes', () => {
    const stream = new Stream(startSession())

    stream.apply(onSpawn(stream.session, spawnInput()))
    stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: 'agent-1', isDenied: false }))
    stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'call-1',
        isDenied: false,
        isError: true,
        text: 'boom',
        totalTokens: 900,
        now: 1,
      }),
    )

    expect(stream.session.thresholds.search.haikuMax).toBe(
      DEFAULT_THRESHOLDS.search.haikuMax - TUNING.tightenStep,
    )
    expect(stream.session.agents[0]).toMatchObject({ status: 'retrying', wastedTokens: 900 })
  })

  it('does not retry a second time: a failed retry is final and logged as a failure', () => {
    const stream = new Stream(startSession())
    const { models, attempts } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '', isError: true }, { text: '2 tests failed' }, { text: 'never reached' }],
    })

    expect(models).toEqual(['haiku', 'sonnet'])
    expect(attempts).toBe(2)
    expect(stream.session.outcomes).toEqual([
      expect.objectContaining({ tier: 'sonnet', retries: 1, isSuccess: false, signal: 'failing-tests' }),
    ])
    expect(stream.session.agents[0]?.status).toBe('failed')
  })

  it('counts the failed attempt as a cost', () => {
    const clean = new Stream(startSession())
    const retried = new Stream(startSession())

    clean.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] })
    retried.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '', isError: true }, { text: 'ok' }],
    })

    expect(retried.session.saved).toBeLessThan(clean.session.saved)
    // Nothing asked for these delegations, so no context saving is claimed for them.
    expect(clean.session.keptOut).toBe(0)
  })

  it('routes one tier up for the turn after the user rejects a result', () => {
    const stream = new Stream(startSession())

    prompt(stream, SEARCH_PROMPT)
    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'Found 2.' }] })
    prompt(stream, 'no, that is wrong, try again')

    expect(stream.session.boost).toBe(1)
    expect(stream.session.outcomes.at(-1)).toMatchObject({ signal: 'user-rejection', isSuccess: false })
    expect(stream.session.thresholds.search.haikuMax).toBeLessThan(DEFAULT_THRESHOLDS.search.haikuMax)
    expect(stream.toasts().at(-1)).toContain('rejected')
    expect(stream.runAgent({ toolUseId: 'call-2', prompt: SEARCH_PROMPT, results: [{ text: 'Found 14.' }] }).models).toEqual(['sonnet'])

    prompt(stream, 'thanks, now add tests')

    expect(stream.session.boost).toBe(0)
  })

  it('does not treat "no" as a rejection when the last turn had nothing of its own', () => {
    const stream = new Stream(startSession())

    prompt(stream, 'no, do it differently')

    expect(stream.session.boost).toBe(0)
    expect(stream.session.outcomes).toEqual([])
  })
})

describe('fallback', () => {
  it('meters from turn.complete when no turn.step event arrives', () => {
    const stream = new Stream(startSession())

    stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: 'ok' }],
      tokens: 3000,
      hasSteps: false,
    })

    expect(stream.session.spend.haiku).toBe(3200)
    expect(stream.session.agents[0]?.tokens).toBe(3200)
  })

  it('does not count a turn twice when both events arrive', () => {
    const stream = new Stream(startSession())
    const usage = { model: OPUS, input: 1000, output: 100, cacheWrite: 50 }

    stream.apply(onStepUsage(stream.session, { turnId: 't1', agentId: undefined, usage }))
    stream.apply(onStepUsage(stream.session, { turnId: 't1', agentId: undefined, usage }))
    stream.apply(
      onTurnComplete(stream.session, {
        turnId: 't1',
        agentId: undefined,
        usage: { ...usage, input: 2000, output: 200, cacheWrite: 100 },
        isFailed: false,
        isAborted: false,
        answer: 'done',
        now: 1,
      }),
    )

    expect(stream.session.spend.opus).toBe(2300)
    expect(stream.session.savedHistory).toEqual([0])
  })

  it('uses the Agent call totals when neither usage event was seen', () => {
    const stream = new Stream(startSession())

    stream.apply(onSpawn(stream.session, spawnInput()))
    stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: 'agent-1', isDenied: false }))
    stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'call-1',
        isDenied: false,
        isError: false,
        text: 'ok',
        totalTokens: 5000,
        now: 1,
      }),
    )

    expect(stream.session.outcomes[0]?.tokens).toBe(5000)
  })

  it('leaves a spawn untouched under a model family it does not know', () => {
    const stream = new Stream(startSession())
    const { models } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      parentModel: 'vendor-model-x',
      results: [{ text: 'ok' }],
    })

    expect(models).toEqual([undefined])
    expect(stream.session.spend.other).toBeGreaterThan(0)
    expect(stream.session.outcomes).toEqual([])
  })

  it('ignores events about agents it never saw start', () => {
    const stream = new Stream(startSession())

    stream.apply(onSpawned(stream.session, { toolUseId: 'ghost', agentId: 'a', isDenied: false }))
    stream.apply(
      onTurnComplete(stream.session, {
        turnId: 't',
        agentId: 'ghost-agent',
        usage: undefined,
        isFailed: false,
        isAborted: false,
        answer: '',
        now: 1,
      }),
    )

    const reply = stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'ghost',
        isDenied: false,
        isError: true,
        text: '',
        totalTokens: undefined,
        now: 1,
      }),
    )

    expect(reply.retryWith).toBeUndefined()
    expect(stream.session.agents).toEqual([])
  })

  it('recovers from a corrupted store and says so', () => {
    const step = hydrate({
      options: {},
      storedLog: [outcome({ seq: 1 }), 'junk', { seq: 'x' }],
      storedThresholds: 'not thresholds',
      storedSettings: 7,
      noColor: undefined,
    })

    expect(step.session.outcomes).toHaveLength(1)
    expect(step.session.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(step.effects).toEqual([
      { kind: 'log', text: expect.stringContaining('2 unreadable entries dropped') },
      { kind: 'save-log' },
    ])
    expect(hydrate({ options: {}, storedLog: 'x', storedThresholds: undefined, storedSettings: undefined, noColor: '1' }).effects[0]).toEqual({
      kind: 'log',
      text: expect.stringContaining('1 unreadable entry dropped'),
    })
  })

  it('applies learning from a stored log when the session starts', () => {
    const session = startSession({}, { log: cleanRun(TUNING.minSamples, 'search', 'haiku') })

    expect(session.thresholds.search.haikuMax).toBe(
      DEFAULT_THRESHOLDS.search.haikuMax + TUNING.loosenStep,
    )
  })
})

describe('background agents and interrupts', () => {
  const background = (answer: string, extra: { isFailed?: boolean; isAborted?: boolean } = {}): Stream => {
    const stream = new Stream(startSession())

    stream.apply(onSpawn(stream.session, spawnInput({ isBackground: true })))
    stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: 'agent-1', isDenied: false }))

    const launched = stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'call-1',
        isDenied: false,
        isError: false,
        text: 'Launched in the background.',
        totalTokens: undefined,
        now: 1,
      }),
    )

    expect(launched.retryWith).toBeUndefined()
    expect(stream.session.outcomes).toEqual([])

    stream.apply(
      onTurnComplete(stream.session, {
        turnId: 't',
        agentId: 'agent-1',
        usage: { model: HAIKU, input: 2000, output: 100, cacheWrite: 0 },
        isFailed: extra.isFailed === true,
        isAborted: extra.isAborted === true,
        answer,
        now: 2,
      }),
    )

    return stream
  }

  it('settles a background agent when its own turn completes', () => {
    const stream = background('Found 3 usages.')

    expect(stream.session.outcomes).toEqual([expect.objectContaining({ isSuccess: true, tier: 'haiku' })])
    expect(stream.session.agents[0]?.status).toBe('done')
  })

  it('logs a failed background agent and tightens, without a retry', () => {
    const stream = background('', { isFailed: true })

    expect(stream.session.outcomes).toEqual([expect.objectContaining({ isSuccess: false, signal: 'error' })])
    expect(stream.session.thresholds.search.haikuMax).toBeLessThan(DEFAULT_THRESHOLDS.search.haikuMax)
  })

  it('treats an interrupt as the user’s choice: no outcome, no retry', () => {
    const stream = background('', { isAborted: true })

    expect(stream.session.outcomes).toEqual([])
    expect(stream.session.agents[0]?.status).toBe('failed')
    expect(stream.session.thresholds).toEqual(DEFAULT_THRESHOLDS)

    const reply = stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'call-1',
        isDenied: false,
        isError: true,
        text: 'interrupted',
        totalTokens: undefined,
        now: 3,
      }),
    )

    expect(reply.retryWith).toBeUndefined()
  })
})

describe('dry-run', () => {
  it('shows what it would do and changes nothing', () => {
    const stream = new Stream(startSession({ dryRun: true }))

    expect(prompt(stream, SEARCH_PROMPT)).toBeUndefined()

    const { models, attempts } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '2 tests failed' }, { text: 'never reached' }],
    })

    expect(models).toEqual([undefined])
    expect(attempts).toBe(1)
    expect(stream.toasts()).toEqual([
      expect.stringContaining('dry-run: would suggest delegating this search'),
      expect.stringContaining('dry-run: would run'),
    ])
    expect(stream.toasts()[1]).toContain('on haiku')
    expect(stream.session.outcomes).toEqual([])
    expect(stream.session.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(stream.session.saved).toBe(0)
    expect(stream.session.agents[0]).toMatchObject({ isDryRun: true, tier: 'haiku' })
    expect(stream.kinds()).not.toContain('save-log')
  })

  it('can be switched on and off with the command, and the switch is kept', () => {
    const stream = new Stream(startSession())

    stream.apply(onCommand(stream.session, 'dry-run on', 1))
    expect(stream.session.config.isDryRun).toBe(true)
    expect(stream.session.overrides).toEqual({ isDryRun: true })
    expect(stream.kinds()).toContain('save-settings')

    stream.apply(onCommand(stream.session, 'dry-run', 1))
    expect(stream.session.config.isDryRun).toBe(false)

    expect(startSession({}, { settings: { isDryRun: true } }).config.isDryRun).toBe(true)
  })
})

describe('the master switch', () => {
  it('passes everything through untouched while off', () => {
    const stream = new Stream(startSession({ enabled: false }))

    expect(prompt(stream, SEARCH_PROMPT)).toBeUndefined()

    const { models } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '', isError: true }, { text: 'never reached' }],
    })

    expect(models).toEqual([undefined])
    expect(stream.effects).toEqual([])
    expect(stream.session.agents).toEqual([])
    expect(stream.session.spend).toEqual({ haiku: 0, sonnet: 0, opus: 0, other: 0 })
    expect(stream.session.outcomes).toEqual([])
    expect(isAnimating(stream.session)).toBe(false)
  })

  it('turns off and back on with the command', () => {
    const stream = new Stream(startSession())

    stream.apply(onCommand(stream.session, 'off', 1))
    expect(stream.session.config.isEnabled).toBe(false)
    expect(stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] }).models).toEqual([undefined])

    stream.apply(onCommand(stream.session, 'on', 1))
    expect(stream.session.config.isEnabled).toBe(true)
    expect(stream.runAgent({ toolUseId: 'call-2', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] }).models).toEqual(['haiku'])
  })

  it('lets a stored switch override the plugin option', () => {
    expect(startSession({ enabled: true }, { settings: { isEnabled: false } }).config.isEnabled).toBe(false)
  })
})

describe('commands', () => {
  it('reports status without touching the session', () => {
    const stream = new Stream(startSession())
    const before = stream.session

    stream.apply(onCommand(stream.session, '', 1))

    expect(stream.session).toBe(before)
    expect(stream.effects).toEqual([{ kind: 'log', text: expect.stringContaining('tokensaver is on') }])
  })

  it('prints help, and help for a word it does not know', () => {
    const stream = new Stream(startSession())

    stream.apply(onCommand(stream.session, 'help', 1))
    stream.apply(onCommand(stream.session, 'frobnicate', 1))

    expect(stream.effects[0]).toEqual({ kind: 'log', text: expect.stringContaining('/tokensaver export') })
    expect(stream.effects[1]).toEqual({ kind: 'log', text: expect.stringContaining('unknown command "frobnicate"') })
  })

  it('opens the dashboard', () => {
    const stream = new Stream(startSession())

    stream.apply(onCommand(stream.session, 'dashboard', 1))

    expect(stream.kinds()).toEqual(['open-dashboard'])
  })

  it('resets the log and the learned thresholds', () => {
    const stream = new Stream(startSession())

    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: '', isError: true }, { text: 'ok' }] })
    expect(stream.session.outcomes).not.toEqual([])
    expect(stream.session.thresholds).not.toEqual(DEFAULT_THRESHOLDS)

    stream.apply(onCommand(stream.session, 'reset', 1))

    expect(stream.session.outcomes).toEqual([])
    expect(stream.session.thresholds).toEqual(DEFAULT_THRESHOLDS)
    expect(stream.session.saved).toBe(0)
    expect(stream.kinds()).toContain('clear-log')
  })

  it('exports to a local file and nowhere else', () => {
    const stream = new Stream(startSession({}, { log: cleanRun(3, 'search', 'haiku') }))

    stream.apply(onCommand(stream.session, 'export', 77))
    stream.apply(onCommand(stream.session, 'export out/my log.json', 77))

    const exports = stream.effects.flatMap(effect => (effect.kind === 'export' ? [effect] : []))

    expect(exports.map(effect => effect.path)).toEqual(['tokensaver-export.json', 'out/my log.json'])
    expect(JSON.parse(exports[0]?.json ?? '{}')).toMatchObject({
      format: 'tokensaver-export',
      exportedAt: 77,
      summary: { count: 3 },
    })
    expect(stream.kinds().filter(kind => kind !== 'export' && kind !== 'log')).toEqual([])
  })

  it('switches motion', () => {
    const stream = new Stream(startSession())

    stream.apply(onCommand(stream.session, 'motion off', 1))
    expect(stream.session.config.hasReducedMotion).toBe(true)

    stream.apply(onCommand(stream.session, 'motion', 1))
    expect(stream.session.config.hasReducedMotion).toBe(false)
  })
})

describe('the meter and the animation clock', () => {
  it('follows the context window', () => {
    const stream = new Stream(startSession())

    stream.apply(onMeasure(stream.session, { tokens: 48_000, window: 200_000 }))
    stream.apply(onMeasure(stream.session, { tokens: undefined, window: 200_000 }))

    expect(stream.session.context).toEqual({ tokens: 48_000, window: 200_000 })
  })

  it('eases the saved counter toward its value and then rests', () => {
    let session = { ...startSession(), saved: 900 }
    const seen: number[] = []

    expect(isAnimating(session)).toBe(true)

    for (let frame = 0; frame < 40 && isAnimating(session); frame += 1) {
      session = onTick(session).session
      seen.push(session.shownSaved)
    }

    expect(seen.at(-1)).toBe(900)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen.length).toBeGreaterThan(3)
    expect(isAnimating(session)).toBe(false)
  })

  it('jumps straight to the value under reduced motion and never animates', () => {
    const session = { ...startSession({ reducedMotion: true }), saved: 900 }

    expect(isAnimating(session)).toBe(false)

    const ticked = onTick(session).session

    expect(ticked.shownSaved).toBe(900)
    expect(ticked.frame).toBe(0)
  })
})
