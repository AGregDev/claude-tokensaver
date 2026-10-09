import { describe, expect, it } from 'vitest'

import { hydrate, onSpawn, onSpawned } from '../../src/runtime/session.ts'
import type { Session } from '../../src/runtime/session.ts'
import { renderDashboard, sparklineLine } from '../../src/ui/dashboard.ts'
import { bar, fit, formatTokens, padEnd, padStart, sparkline, sparklineSvg, spinner } from '../../src/ui/format.ts'
import { renderStatusLine } from '../../src/ui/statusline.ts'
import { plain, span } from '../../src/ui/theme.ts'
import type { Line } from '../../src/ui/theme.ts'
import { themeOf, toView } from '../../src/ui/view.ts'
import type { View } from '../../src/ui/view.ts'
import { OPUS, SEARCH_PROMPT, Stream, cleanRun, startSession } from '../helpers.ts'

/** A session with spend, savings, history and a three-agent tree, one of them nested. */
const busySession = (options: Record<string, unknown> = {}): Session => {
  const stream = new Stream(startSession(options, { log: cleanRun(4, 'search', 'haiku') }))

  stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] })
  stream.runAgent({
    toolUseId: 'call-2',
    prompt: 'rename getUser to fetchUser in every file',
    results: [{ text: '', isError: true }, { text: 'ok' }],
  })

  for (const [toolUseId, parentAgentId] of [
    ['call-3', undefined],
    ['call-4', 'agent-live'],
  ] as const) {
    stream.apply(
      onSpawn(stream.session, {
        toolUseId,
        prompt: 'summarize the build logs and give me a recap of every warning',
        description: 'summarize logs',
        subagentType: 'general-purpose',
        explicitModel: undefined,
        parentModel: OPUS,
        parentAgentId,
        isBackground: false,
        isPinned: false,
      }),
    )
    stream.apply(
      onSpawned(stream.session, {
        toolUseId,
        agentId: toolUseId === 'call-3' ? 'agent-live' : 'agent-child',
        isDenied: false,
      }),
    )
  }

  return {
    ...stream.session,
    context: { tokens: 48_000, window: 200_000 },
    savedHistory: [0, 400, 900, 2600, 5200],
    shownSaved: 1234,
  }
}

const viewOf = (options: Record<string, unknown> = {}, hasNoColor = false): View => ({
  ...toView(busySession(options)),
  hasNoColor,
})

const allLines = (view: View, columns = 60): Line[] => {
  const dashboard = renderDashboard(view, columns)

  return [...dashboard.top, sparklineLine(view, columns), ...dashboard.bottom]
}

const text = (view: View, columns = 60): string => allLines(view, columns).map(plain).join('\n')

describe('format', () => {
  it('formats token counts', () => {
    expect([0, 950, 1000, 12_345, 2_500_000, -1500].map(formatTokens)).toEqual([
      '0',
      '950',
      '1.0k',
      '12.3k',
      '2.5M',
      '-1.5k',
    ])
  })

  it('draws a meter of a fixed width', () => {
    expect(bar(0, 8)).toBe('░░░░░░░░')
    expect(bar(0.5, 8)).toBe('████░░░░')
    expect(bar(1, 8)).toBe('████████')
    expect(bar(7, 8)).toBe('████████')
    expect(bar(-1, 8)).toBe('░░░░░░░░')
    expect(bar(Number.NaN, 4)).toBe('░░░░')
    expect(bar(0.5, 0)).toHaveLength(1)
  })

  it('draws a sparkline scaled to its own range', () => {
    expect(sparkline([], 8)).toBe('')
    expect(sparkline([5, 5, 5], 8)).toBe('▁▁▁')
    expect(sparkline([0, 50, 100], 8)).toBe('▁▅█')
    expect(sparkline([1, 2, 3, 4, 5], 2)).toHaveLength(2)
  })

  it('turns the spinner with the frame, and holds still without motion', () => {
    const frames = [0, 1, 2, 3, 4].map(frame => spinner(frame, true))

    expect(new Set(frames).size).toBe(4)
    expect(frames[4]).toBe(frames[0])
    expect([0, 1, 2].map(frame => spinner(frame, false))).toEqual(['◆', '◆', '◆'])
  })

  it('pads and cuts text', () => {
    expect(padEnd('ab', 4)).toBe('ab  ')
    expect(padEnd('abcdef', 4)).toBe('abcdef')
    expect(padStart('ab', 4)).toBe('  ab')
    expect(padStart('abcdef', 4)).toBe('abcdef')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(fit('abc', 4)).toBe('abc')
    expect(fit('abc', 1)).toBe('a')
  })

  it('draws the savings history as an SVG that follows the theme', () => {
    const svg = sparklineSvg([0, 400, 900, 2600])

    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('stroke="currentColor"')
    expect(svg).toContain('<polyline')
    expect(svg).not.toMatch(/<script|onload|href=/)
    expect(svg.match(/\d+\.\d,\d+\.\d/g)).toHaveLength(4)
    expect(sparklineSvg([])).toContain('<polyline')
    expect(sparklineSvg([7])).toContain('<polyline')
  })
})

describe('theme', () => {
  it('drops the tone under NO_COLOR and keeps the rest', () => {
    const colored = span({ hasColor: true, hasMotion: true }, 'x', { tone: 'error', isBold: true })
    const mono = span({ hasColor: false, hasMotion: true }, 'x', { tone: 'error', isDim: true })

    expect(colored).toEqual({ text: 'x', tone: 'error', isBold: true })
    expect(mono).toEqual({ text: 'x', isDim: true })
    expect(span({ hasColor: true, hasMotion: true }, 'x')).toEqual({ text: 'x' })
  })
})

describe('view', () => {
  it('summarises the session for drawing', () => {
    const view = viewOf()

    expect(view.mode).toBe('on')
    expect(view.total).toBe(view.spend.haiku + view.spend.sonnet + view.spend.opus + view.spend.other)
    expect(view.activeCount).toBe(2)
    expect(view.learning.count).toBe(6)
    expect(themeOf(view)).toEqual({ hasColor: true, hasMotion: true })
  })

  it('orders agents as a tree: a child follows its parent, one level deeper', () => {
    const view = viewOf()

    expect(view.agents.map(agent => [agent.key, agent.guides, agent.isLast])).toEqual([
      ['call-1', [], false],
      ['call-2', [], false],
      ['call-3', [], true],
      ['call-4', [false], true],
    ])
  })

  it('names the mode', () => {
    expect(viewOf({ enabled: false }).mode).toBe('off')
    expect(viewOf({ dryRun: true }).mode).toBe('dry-run')
  })
})

describe('status line', () => {
  it('shows the meter, the savings, per-tier spend, the sparkline and the agents', () => {
    const line = renderStatusLine(viewOf()) ?? ''

    expect(line).toMatch(/^[◐◓◑◒] tokensaver \d+\.\dk tok · saved ~1\.2k · H \S+ S \S+ O \S+ · [▁-█]+ · 2 agents$/u)
  })

  it('animates only the spinner glyph between frames', () => {
    const view = viewOf()
    const first = renderStatusLine({ ...view, frame: 0 }) ?? ''
    const second = renderStatusLine({ ...view, frame: 1 }) ?? ''

    expect(first).not.toBe(second)
    expect(first.slice(1)).toBe(second.slice(1))
  })

  it('holds still under reduced motion and shows the final saved figure', () => {
    const view = viewOf({ reducedMotion: true })
    const first = renderStatusLine({ ...view, frame: 0 }) ?? ''
    const second = renderStatusLine({ ...view, frame: 9 }) ?? ''

    expect(first).toBe(second)
    expect(first.startsWith('◆ ')).toBe(true)
    expect(first).toContain(`saved ~${formatTokens(view.saved)}`)
    expect(first).not.toContain('saved ~1.2k')
  })

  it('rests on a plain dot when no agent is running', () => {
    const view = { ...viewOf(), activeCount: 0 }
    const line = renderStatusLine(view) ?? ''

    expect(line.startsWith('● ')).toBe(true)
    expect(line).not.toContain('agent')
  })

  it('says "1 agent" for one', () => {
    expect(renderStatusLine({ ...viewOf(), activeCount: 1 })).toContain('· 1 agent')
  })

  it('marks a dry run', () => {
    expect(renderStatusLine(viewOf({ dryRun: true }))).toContain('tokensaver [dry-run]')
  })

  it('clears itself when tokensaver is off or the line is switched off', () => {
    expect(renderStatusLine(viewOf({ enabled: false }))).toBeUndefined()
    expect(renderStatusLine(viewOf({ statusLine: false }))).toBeUndefined()
  })

  it('leaves the sparkline out until there is a history', () => {
    expect(renderStatusLine({ ...viewOf(), history: [3] })).not.toMatch(/[▁-█]/u)
  })

  it('carries no escape codes, so NO_COLOR has nothing to strip', () => {
    for (const view of [viewOf(), viewOf({}, true)]) {
      expect(renderStatusLine(view)).not.toContain('\u001B')
    }
  })
})

describe('dashboard', () => {
  it('draws every section', () => {
    const drawn = text(viewOf())

    expect(drawn).toContain('tokensaver ● on')
    expect(drawn).toMatch(/Context\s+█+░+\s+48\.0k \/ 200\.0k\s+24%/u)
    expect(drawn).toMatch(/Session\s+\S+ tokens/u)
    expect(drawn).toMatch(/Saved\s+~1\.2k est\./u)
    expect(drawn).toMatch(/Trend\s+[▁-█]{5}/u)
    expect(drawn).toContain('Kept out')
    expect(drawn).toContain('of main context')
    expect(drawn).toContain('Per tier')
    expect(drawn).toMatch(/haiku\s+[█░]+\s+\S+/u)
    expect(drawn).toContain('Delegation')
    expect(drawn).toMatch(/Learning\s+6 runs · \d+% clean · 1 escalated/u)
    expect(drawn).toContain('Recent')
  })

  it('draws the delegation tree with tiers, states and the escalation', () => {
    const lines = allLines(viewOf()).map(plain)
    const tree = lines.slice(lines.indexOf('Delegation') + 1, lines.findIndex(line => line.startsWith('Learning')))

    expect(tree[0]).toBe('  main')
    expect(tree[1]).toMatch(/^ {2}├─ ✓ haiku {3}find all usages/u)
    expect(tree[2]).toMatch(/^ {2}├─ ✓ sonnet {2}rename getUser.*… \(was haiku\)/u)
    expect(tree[3]).toMatch(/^ {2}└─ [◐◓◑◒] haiku {3}summarize logs/u)
    // The parent is the last of its level, so no guide line runs down beside its child.
    expect(tree[4]).toMatch(/^ {5}└─ [◐◓◑◒] haiku {3}summarize logs/u)
  })

  it('uses colour to mark state when colour is allowed', () => {
    const tones = allLines(viewOf()).flat().flatMap(part => (part.tone === undefined ? [] : [part.tone]))

    expect(tones).toContain('success')
    expect(tones).toContain('claude')
    expect(tones).toContain('suggestion')
  })

  it('carries no colour at all under NO_COLOR, and loses no text', () => {
    const colored = viewOf()
    const mono = viewOf({}, true)

    for (const part of allLines(mono).flat()) {
      expect(part).not.toHaveProperty('tone')
    }

    expect(text(mono)).toBe(text(colored))
  })

  it('reads the NO_COLOR variable as set only when it is non-empty', () => {
    const hasNoColor = (noColor: string | undefined): boolean =>
      toView(
        hydrate({
          options: {},
          storedLog: undefined,
          storedThresholds: undefined,
          storedSettings: undefined,
          noColor,
        }).session,
      ).hasNoColor

    expect(hasNoColor('1')).toBe(true)
    expect(hasNoColor('true')).toBe(true)
    expect(hasNoColor('')).toBe(false)
    expect(hasNoColor(undefined)).toBe(false)
  })

  it('freezes the running glyph and shows final figures under reduced motion', () => {
    const view = viewOf({ reducedMotion: true })
    const first = text({ ...view, frame: 0 })
    const second = text({ ...view, frame: 5 })

    expect(first).toBe(second)
    expect(first).toContain('◆ haiku')
    expect(first).toContain(`~${formatTokens(view.saved)} est. by routing`)
  })

  it('turns the running glyph with the frame when motion is on', () => {
    const view = viewOf()

    expect(text({ ...view, frame: 0 })).not.toBe(text({ ...view, frame: 1 }))
  })

  it('fits the width it is given', () => {
    for (const columns of [20, 34, 48, 60, 72, 200]) {
      const limit = Math.min(72, Math.max(34, columns))

      for (const line of allLines(viewOf(), columns)) {
        expect(plain(line).length, plain(line)).toBeLessThanOrEqual(limit)
      }
    }
  })

  it('shows the empty states of a fresh session', () => {
    const drawn = text(toView(startSession()))

    expect(drawn).toContain('not measured yet')
    expect(drawn).toContain('builds up over turns')
    expect(drawn).toContain('no sub-agents yet')
    expect(drawn).toContain('no outcomes logged yet')
    expect(drawn).not.toContain('Recent')
  })

  it('warns as the context window fills', () => {
    const toneAt = (tokens: number): string | undefined =>
      renderDashboard({ ...viewOf(), context: { tokens, window: 100 } }, 60).top[1]?.[1]?.tone

    expect(toneAt(10)).toBe('success')
    expect(toneAt(70)).toBe('warning')
    expect(toneAt(95)).toBe('error')
  })

  it('shows off, dry-run, a failure, a planned run and spend on an unknown model', () => {
    const view = viewOf()
    const agents = view.agents.map((agent, index) =>
      index === 0
        ? { ...agent, status: 'failed' as const }
        : index === 1
          ? { ...agent, status: 'planned' as const, tier: undefined }
          : { ...agent, status: 'retrying' as const },
    )
    const drawn = text({ ...view, mode: 'off', agents, spend: { ...view.spend, other: 500 } })

    expect(drawn).toContain('tokensaver ○ off')
    expect(drawn).toContain('✗ haiku')
    expect(drawn).toContain('○ inherit')
    expect(drawn).toContain('↑ haiku')
    expect(drawn).toMatch(/other\s+[█░]+\s+500/u)
    expect(text({ ...view, mode: 'dry-run' })).toContain('tokensaver ◌ dry-run')
  })
})
