/**
 * The safety guarantees, tested as properties over every combination that
 * could break them rather than over a few hand-picked cases.
 */
import { describe, expect, it } from 'vitest'

import { CHECK_SIGNALS, planEscalation } from '../../src/core/escalate.ts'
import { DEFAULT_THRESHOLDS, resolveSpawnModel, routeTier } from '../../src/core/route.ts'
import type { Thresholds } from '../../src/core/route.ts'
import { TASK_TYPES, scoreTask } from '../../src/core/score.ts'
import { TIERS, rankOf, rankOfModel } from '../../src/core/tiers.ts'
import { TUNING, tighten, tuneFromLog } from '../../src/core/tune.ts'
import { onAgentResult, onSpawn, onSpawned } from '../../src/runtime/session.ts'
import { FABLE, HAIKU, OPUS, RISKY_PROMPT, SEARCH_PROMPT, SONNET, Stream, cleanRun, startSession } from '../helpers.ts'

const RISKY_PROMPTS = [
  RISKY_PROMPT,
  'list the files that read the API key',
  'rename the auth helper in every file',
  'find and delete all stale branches',
  'summarize the production deploy logs',
  'grep for the password',
  'rm -rf the build folder',
  'git push --force to main',
  'update the billing export',
  'scan the repo for secrets',
  'write the database migration',
  'fix the typo in the oauth callback',
]

const PARENT_MODELS = [HAIKU, SONNET, OPUS, FABLE]
const EXPLICIT_MODELS = [undefined, 'haiku', 'sonnet', 'opus']

/** Thresholds as loose as they can possibly get: every complexity routes to Haiku. */
const LOOSEST: Thresholds = {
  search: { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  'bulk-read': { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  'repetitive-edit': { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  summarize: { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  edit: { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  reasoning: { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
  general: { haikuMax: 100, sonnetMax: 100, tunedAtSeq: 0 },
}

/** The rank a spawn ends up on: the routed model, else the named one, else the parent's. */
const effectiveRank = (
  model: string | undefined,
  explicitModel: string | undefined,
  parentModel: string,
): number => rankOfModel(model ?? explicitModel ?? parentModel) ?? -1

describe('risky, destructive and production-touching work is never downgraded', () => {
  it('recognises every prompt in the risky set', () => {
    for (const text of RISKY_PROMPTS) {
      expect(scoreTask({ text }).isRisky, text).toBe(true)
    }
  })

  it.each([
    ['default thresholds', DEFAULT_THRESHOLDS],
    ['the loosest thresholds learning could ever produce', LOOSEST],
  ])('holds under %s, for every parent and every named model', (_name, thresholds) => {
    for (const text of RISKY_PROMPTS) {
      for (const parentModel of PARENT_MODELS) {
        for (const explicitModel of EXPLICIT_MODELS) {
          const score = scoreTask({ text })
          const decision = routeTier(score, thresholds)
          const routing = resolveSpawnModel(decision, score, { parentModel, explicitModel })
          const before = effectiveRank(undefined, explicitModel, parentModel)
          const after = effectiveRank(routing.model, explicitModel, parentModel)
          const label = `${text} | parent ${parentModel} | named ${String(explicitModel)}`

          expect(decision.tier, label).toBe('opus')
          expect(after, label).toBeGreaterThanOrEqual(before)
          expect(after, label).toBeGreaterThanOrEqual(rankOfModel(parentModel) ?? 0)
        }
      }
    }
  })

  it('holds end to end: the controller never hands a risky spawn a cheaper model', () => {
    for (const parentModel of PARENT_MODELS) {
      for (const explicitModel of EXPLICIT_MODELS) {
        const step = onSpawn(startSession(), {
          toolUseId: 'call-1',
          prompt: RISKY_PROMPT,
          description: '',
          subagentType: 'general-purpose',
          explicitModel,
          parentModel,
          parentAgentId: undefined,
          isBackground: false,
          isPinned: false,
        })
        const before = effectiveRank(undefined, explicitModel, parentModel)

        expect(effectiveRank(step.reply.model, explicitModel, parentModel)).toBeGreaterThanOrEqual(before)
      }
    }
  })

  it('cannot be learned away: clean history never loosens a risky task below the top tier', () => {
    const log = TASK_TYPES.flatMap((taskType, index) =>
      cleanRun(TUNING.minSamples * 20, taskType, 'haiku', index * 1000 + 1),
    )
    const tuned = tuneFromLog(DEFAULT_THRESHOLDS, log)

    for (const text of RISKY_PROMPTS) {
      expect(routeTier(scoreTask({ text }), tuned).tier, text).toBe('opus')
    }
  })

  it('never reroutes a fork, a teammate or a workflow agent', () => {
    const step = onSpawn(startSession(), {
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      description: '',
      subagentType: 'fork',
      explicitModel: undefined,
      parentModel: OPUS,
      parentAgentId: undefined,
      isBackground: false,
      isPinned: true,
    })

    expect(step.reply.model).toBeUndefined()
  })
})

describe('escalation always moves up, never down', () => {
  it('holds for every tier, signal, attempt count and flag', () => {
    for (const tier of TIERS) {
      for (const signal of CHECK_SIGNALS) {
        for (const attempts of [0, 1, 2, 7]) {
          for (const isDenied of [false, true]) {
            for (const isDryRun of [false, true]) {
              const plan = planEscalation({ signal, tier, attempts, isDenied, isDryRun })

              if (plan.shouldEscalate) {
                expect(rankOf(plan.to)).toBe(rankOf(tier) + 1)
                expect(attempts).toBe(0)
                expect(isDenied).toBe(false)
                expect(signal).not.toBe('ok')
              }
            }
          }
        }
      }
    }
  })

  it('holds for the boost a user rejection adds', () => {
    for (const taskType of TASK_TYPES) {
      for (let complexity = 0; complexity <= 100; complexity += 5) {
        const score = { ...scoreTask({ text: '' }), taskType, complexity, isUnsure: false }
        const plain = routeTier(score, DEFAULT_THRESHOLDS)
        const boosted = routeTier(score, DEFAULT_THRESHOLDS, 1)

        expect(rankOf(boosted.tier)).toBeGreaterThanOrEqual(rankOf(plain.tier))
      }
    }
  })

  it('holds end to end: a retry runs strictly above the tier that failed', () => {
    const stream = new Stream(startSession())
    const { models } = stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '2 tests failed' }, { text: 'All good.' }],
    })

    expect(models).toEqual(['haiku', 'sonnet'])
  })

  it('tightening only ever raises the tier a task routes to', () => {
    for (const taskType of TASK_TYPES) {
      for (const tier of TIERS) {
        const tightened = tighten(DEFAULT_THRESHOLDS, taskType, tier, 1)

        for (let complexity = 0; complexity <= 100; complexity += 1) {
          const score = { ...scoreTask({ text: '' }), taskType, complexity, isUnsure: false }

          expect(rankOf(routeTier(score, tightened).tier)).toBeGreaterThanOrEqual(
            rankOf(routeTier(score, DEFAULT_THRESHOLDS).tier),
          )
        }
      }
    }
  })
})

describe('a denial is never overridden', () => {
  const spawned = (): Stream => {
    const stream = new Stream(startSession())

    stream.apply(
      onSpawn(stream.session, {
        toolUseId: 'call-1',
        prompt: SEARCH_PROMPT,
        description: '',
        subagentType: 'general-purpose',
        explicitModel: undefined,
        parentModel: OPUS,
        parentAgentId: undefined,
        isBackground: false,
        isPinned: false,
      }),
    )

    return stream
  }

  it('never retries a denied Agent call, whatever its text says', () => {
    for (const text of ['', 'Permission denied by rule', '3 tests failed', "I'm not sure"]) {
      const stream = spawned()

      stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: 'agent-1', isDenied: false }))

      const reply = stream.apply(
        onAgentResult(stream.session, {
          toolUseId: 'call-1',
          isDenied: true,
          isError: false,
          text,
          totalTokens: undefined,
          now: 1,
        }),
      )

      expect(reply.retryWith).toBeUndefined()
      expect(stream.session.outcomes).toEqual([])
    }
  })

  it('never retries a spawn that was refused', () => {
    const stream = spawned()

    stream.apply(onSpawned(stream.session, { toolUseId: 'call-1', agentId: undefined, isDenied: true }))

    const reply = stream.apply(
      onAgentResult(stream.session, {
        toolUseId: 'call-1',
        isDenied: false,
        isError: true,
        text: 'refused',
        totalTokens: undefined,
        now: 1,
      }),
    )

    expect(reply.retryWith).toBeUndefined()
  })

  it('produces no effect that could approve, deny or run anything', () => {
    const stream = new Stream(startSession())

    stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '2 tests failed' }, { text: 'done' }],
    })

    // Every effect is display or local storage.
    const allowed = ['toast', 'log', 'save-log', 'save-settings', 'clear-log', 'open-dashboard', 'export']

    for (const kind of stream.kinds()) {
      expect(allowed).toContain(kind)
    }
  })
})
