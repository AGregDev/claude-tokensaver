import { describe, expect, it } from 'vitest'

import {
  addReply,
  averageReply,
  EMPTY_VOICE_STATS,
  parseVoice,
  parseVoiceStats,
  REPORT_NOTE,
  voiceComparison,
  voiceRules,
  voiceSwitchOf,
  withReportNote,
  withTerseSummary,
} from '../../src/core/caveman.ts'
import type { VoiceStats } from '../../src/core/caveman.ts'
import { createAssistant, DEFAULT_ASSISTANT, onPromptText, onTurnEnd, setVoice, speechOf } from '../../src/runtime/assistant.ts'

const tokens = (text: string): number => Math.ceil(text.length / 4)

describe('the caveman rules', () => {
  it('keeps the payload and the negations safe, and stays small', () => {
    const rules = voiceRules('caveman') ?? ''

    expect(rules).toMatch(/Payload verbatim/)
    expect(rules).toMatch(/Never drop not\/never\/no\/only\/except/)
    expect(rules).toMatch(/irreversible action/)
    expect(rules).toMatch(/\/tokensaver caveman off/)
    // Caveman's own rules cost about 1,160 tokens; condensed they must stay well under.
    expect(tokens(rules)).toBeLessThan(800)
  })

  it('adds the ultra rules on top, and nothing for off', () => {
    expect(voiceRules('ultra')).toContain(voiceRules('caveman'))
    expect(voiceRules('ultra')).toMatch(/grammar stripped/)
    expect(voiceRules('off')).toBeUndefined()
  })
})

describe('switching the voice', () => {
  it('reads options and command words', () => {
    expect(parseVoice('on')).toBe('caveman')
    expect(parseVoice(' ULTRA ')).toBe('ultra')
    expect(parseVoice('ultracave')).toBe('ultra')
    expect(parseVoice('off')).toBe('off')
    expect(parseVoice('loud')).toBeUndefined()
    expect(parseVoice(3)).toBeUndefined()
  })

  it('takes a whole prompt as a switch, never a task that mentions one', () => {
    expect(voiceSwitchOf('stop caveman')).toBe('off')
    expect(voiceSwitchOf('  Normal mode! ')).toBe('off')
    expect(voiceSwitchOf('caveman ultra')).toBe('ultra')
    expect(voiceSwitchOf('talk like a caveman.')).toBe('caveman')
    expect(voiceSwitchOf('switch vim back to normal mode after the edit')).toBeUndefined()
    expect(voiceSwitchOf('why does caveman mode drop articles?')).toBeUndefined()
    expect(voiceSwitchOf('constructor')).toBeUndefined()
  })

  it('switches from a prompt the person typed, and still lets it through', () => {
    const step = onPromptText(createAssistant(DEFAULT_ASSISTANT), {
      text: 'stop caveman',
      isFromUser: true,
      isEnabled: true,
      isDryRun: false,
      now: 0,
    })

    expect(step.reply).toEqual({ text: undefined, voice: 'off' })
    expect(step.assistant.config.voice).toBe('off')
    expect(step.effects).toEqual([{ kind: 'save-assistant' }])
  })

  it('ignores switch phrases that did not come from the person, or while tokensaver is off', () => {
    const base = createAssistant(DEFAULT_ASSISTANT)
    const input = { text: 'stop caveman', isDryRun: false, now: 0 }

    expect(onPromptText(base, { ...input, isFromUser: false, isEnabled: true }).reply.voice).toBeUndefined()
    expect(onPromptText(base, { ...input, isFromUser: true, isEnabled: false }).reply.voice).toBeUndefined()
  })

  it('says what changed, and Clawd greets with it', () => {
    const quiet = setVoice(createAssistant(DEFAULT_ASSISTANT), 'off', 0)

    expect(quiet.reply.text).toMatch(/normal voice/)
    expect(speechOf(quiet.assistant, { now: 60_000, isEnabled: true, activeAgents: 0 })).not.toMatch(/caveman/)
    expect(speechOf(createAssistant(DEFAULT_ASSISTANT), { now: 0, isEnabled: true, activeAgents: 0 })).toMatch(/caveman/)
  })
})

describe('what the voice reaches besides replies', () => {
  it('asks a sub-agent for a terse report, once', () => {
    const asked = withReportNote('list every caller of parseConfig')

    expect(asked.startsWith('list every caller of parseConfig')).toBe(true)
    expect(asked).toContain(REPORT_NOTE)
    expect(withReportNote(asked)).toBe(asked)
  })

  it('asks for a terse compaction summary, keeping what the person gave, once', () => {
    expect(withTerseSummary(undefined)).toMatch(/caveman style/)
    expect(withTerseSummary('focus on the auth bug')).toMatch(/^focus on the auth bug .*caveman style/)
    expect(withTerseSummary(withTerseSummary('x'))).toBe(withTerseSummary('x'))
  })
})

describe('measuring the voice', () => {
  const fill = (stats: VoiceStats, isTerse: boolean, outputs: readonly number[]): VoiceStats =>
    outputs.reduce((sum, output) => addReply(sum, { isTerse, output }), stats)

  it('says nothing until both voices have enough replies', () => {
    expect(voiceComparison(fill(EMPTY_VOICE_STATS, true, [100, 100, 100, 100, 100]))).toBeUndefined()
  })

  it('compares average output per reply', () => {
    const stats = fill(fill(EMPTY_VOICE_STATS, true, [200, 200, 200, 200, 200]), false, [400, 400, 400, 400, 400])

    expect(voiceComparison(stats)).toEqual({ terse: 200, plain: 400, cut: 50 })
    expect(averageReply(stats.plain)).toBe(400)
  })

  it('skips empty replies and reads a damaged store as empty', () => {
    expect(addReply(EMPTY_VOICE_STATS, { isTerse: true, output: 0 })).toBe(EMPTY_VOICE_STATS)
    expect(addReply(EMPTY_VOICE_STATS, { isTerse: true, output: Number.NaN })).toBe(EMPTY_VOICE_STATS)
    expect(parseVoiceStats({ terse: { turns: -1, output: 3 }, plain: 'x' })).toEqual(EMPTY_VOICE_STATS)
    expect(parseVoiceStats({ terse: { turns: 2, output: 30 } }).terse).toEqual({ turns: 2, output: 30 })
  })

  it('tallies only finished replies, under the voice they were written in', () => {
    const base = createAssistant(DEFAULT_ASSISTANT)

    expect(onTurnEnd(base, { now: 1, output: 300, isFinished: true, isTerse: false }).replies.plain).toEqual({ turns: 1, output: 300 })
    expect(onTurnEnd(base, { now: 1, output: 300, isFinished: false, isTerse: true }).replies).toEqual(EMPTY_VOICE_STATS)
  })
})
