import { describe, expect, it } from 'vitest'

import { coldCost, compactInstructions, isCacheCold, levelOf } from '../../src/core/guardian.ts'
import {
  createAssistant,
  DEFAULT_ASSISTANT,
  moodOf,
  onCompacted,
  onContext,
  onIdleCheck,
  onMainRequest,
  onPromptText,
  onToolOutput,
  onTurnEnd,
  requestCompact,
} from '../../src/runtime/assistant.ts'

const NOISY = Array.from({ length: 400 }, () => 'npm WARN deprecated left-pad@1.0.0').join('\n')
const base = createAssistant(DEFAULT_ASSISTANT)
const state = { now: 0, isEnabled: true, activeAgents: 0 }

describe('guardian', () => {
  it('names levels by fill', () => {
    expect(levelOf(10)).toBe('calm')
    expect(levelOf(55)).toBe('filling')
    expect(levelOf(72)).toBe('heavy')
    expect(levelOf(90)).toBe('critical')
  })

  it('calls a cache cold only after its lifetime, between turns, for a big context', () => {
    const cold = { idleMs: 6 * 60_000, ttlMs: 5 * 60_000, tokens: 80_000, isTurnRunning: false }

    expect(isCacheCold(cold)).toBe(true)
    expect(isCacheCold({ ...cold, idleMs: 60_000 })).toBe(false)
    expect(isCacheCold({ ...cold, tokens: 5000 })).toBe(false)
    expect(isCacheCold({ ...cold, isTurnRunning: true })).toBe(false)
    expect(coldCost(100_000).compacted).toBeLessThan(coldCost(100_000).now)
  })

  it('builds compaction instructions from recent asks', () => {
    expect(compactInstructions(['fix the login bug'])).toContain('fix the login bug')
  })
})

describe('assistant', () => {
  it('trims shell output, chomps, and counts what later requests did not re-send', () => {
    const step = onToolOutput(base, { tool: 'Bash', text: NOISY, isEnabled: true, isDryRun: false, now: 0 })

    expect(step.reply.text).toBeDefined()
    expect(step.assistant.trimmed).toBeGreaterThan(0)
    expect(moodOf(step.assistant, state)).toBe('chomp')

    const later = onMainRequest(onMainRequest(step.assistant))

    expect(later.reReads).toBe(step.assistant.live * 2)
  })

  it('never touches file reads, and changes nothing when off or in dry-run', () => {
    expect(onToolOutput(base, { tool: 'Read', text: NOISY, isEnabled: true, isDryRun: false, now: 0 }).reply.text).toBeUndefined()
    expect(onToolOutput(base, { tool: 'Bash', text: NOISY, isEnabled: false, isDryRun: false, now: 0 }).reply.text).toBeUndefined()
    expect(onToolOutput(base, { tool: 'Bash', text: NOISY, isEnabled: true, isDryRun: true, now: 0 }).reply.text).toBeUndefined()
  })

  it('tidies a pasted log losslessly, and leaves a slash command alone', () => {
    const pasted = `why does this fail?\n${NOISY}`
    const tidied = onPromptText(base, { text: pasted, isFromUser: true, isEnabled: true, isDryRun: false, now: 0 })

    expect(tidied.reply.text).toContain('why does this fail?')
    expect(tidied.reply.text).toContain('repeated')
    expect(onPromptText(base, { text: pasted, isFromUser: false, isEnabled: true, isDryRun: false, now: 0 }).reply.text).toBeUndefined()
  })

  it('warns once per level crossed and resets after a compaction', () => {
    const heavy = onContext(base, { tokens: 150_000, window: 200_000, isEnabled: true, now: 0 })

    expect(heavy.effects.some(effect => effect.kind === 'toast')).toBe(true)
    expect(onContext(heavy.assistant, { tokens: 151_000, window: 200_000, isEnabled: true, now: 1 }).effects).toEqual([])

    const compacted = onCompacted(heavy.assistant, { before: 150_000, after: 12_000, isSkipped: false, now: 2 })

    expect(compacted.compactFreed).toBe(138_000)
    expect(compacted.warnedLevel).toBe('calm')
    expect(compacted.live).toBe(0)
  })

  it('auto-compacts only when opted in, and only between turns', () => {
    const optedIn = createAssistant({ ...DEFAULT_ASSISTANT, autoCompactAt: 80 })
    const between = onContext(optedIn, { tokens: 170_000, window: 200_000, isEnabled: true, now: 0 })

    expect(between.effects.some(effect => effect.kind === 'compact')).toBe(true)
    expect(onContext(base, { tokens: 170_000, window: 200_000, isEnabled: true, now: 0 }).effects.some(effect => effect.kind === 'compact')).toBe(false)

    const running = onPromptText(optedIn, { text: 'go', isFromUser: true, isEnabled: true, isDryRun: false, now: 0 }).assistant

    expect(onContext(running, { tokens: 170_000, window: 200_000, isEnabled: true, now: 0 }).effects.some(effect => effect.kind === 'compact')).toBe(false)
    expect(requestCompact(running).reply.instructions).toBeUndefined()
  })

  it('falls asleep on a cold cache and wakes on the next prompt', () => {
    const measured = onContext(base, { tokens: 90_000, window: 200_000, isEnabled: true, now: 0 }).assistant
    const ended = onTurnEnd(measured, 0)
    const cold = onIdleCheck(ended, { now: 6 * 60_000, isEnabled: true })

    expect(cold.isCold).toBe(true)
    expect(moodOf(cold, { ...state, now: 6 * 60_000 })).toBe('sleepy')
    expect(onPromptText(cold, { text: 'hi', isFromUser: true, isEnabled: true, isDryRun: false, now: 7 * 60_000 }).assistant.isCold).toBe(false)
  })
})
