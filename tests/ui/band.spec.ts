import { describe, expect, it } from 'vitest'

import { onSpawn, onSpawned } from '../../src/runtime/session.ts'
import type { Session } from '../../src/runtime/session.ts'
import { BAND_HEIGHT, bandLine, bandSvg, isBandVisible, routedBadge, spinnerSuffix } from '../../src/ui/band.ts'
import { plain } from '../../src/ui/theme.ts'
import { toView } from '../../src/ui/view.ts'
import type { View } from '../../src/ui/view.ts'
import { OPUS, SEARCH_PROMPT, Stream, startSession } from '../helpers.ts'

/** A session with `count` sub-agents running, routed to haiku. */
const running = (count: number, options: Record<string, unknown> = {}): Session => {
  const stream = new Stream(startSession(options))

  for (let index = 1; index <= count; index += 1) {
    const toolUseId = `call-${String(index)}`

    stream.apply(
      onSpawn(stream.session, {
        toolUseId,
        prompt: SEARCH_PROMPT,
        description: `search part ${String(index)} <fast> & "quoted"`,
        subagentType: 'general-purpose',
        explicitModel: undefined,
        parentModel: OPUS,
        parentAgentId: undefined,
        isBackground: false,
        isPinned: false,
        now: 1000,
      }),
    )
    stream.apply(onSpawned(stream.session, { toolUseId, agentId: `agent-${String(index)}`, isDenied: false }))
  }

  return stream.session
}

const viewOf = (session: Session, extra: Partial<View> = {}): View => ({ ...toView(session), ...extra })

/** A view with nothing running and one fresh event. */
const flashing = (extra: Partial<View> = {}): View => {
  const stream = new Stream(startSession())

  stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'Found 14.' }] })

  return viewOf(stream.session, extra)
}

describe('when the strip shows', () => {
  it('shows while a sub-agent runs', () => {
    expect(isBandVisible(viewOf(running(1)))).toBe(true)
  })

  it('shows for a fresh event, and not once it has aged out', () => {
    const fresh = flashing()

    expect(fresh.band.agents).toEqual([])
    expect(fresh.band.flash?.tone).toBe('done')
    expect(isBandVisible(fresh)).toBe(true)

    const session = { ...running(0), flash: { text: 'old', tone: 'done' as const, at: 0 }, now: 60_000 }

    expect(isBandVisible(viewOf(session))).toBe(false)
  })

  it('is gone when nothing is happening, and when tokensaver is off', () => {
    expect(isBandVisible(viewOf(startSession()))).toBe(false)
    expect(isBandVisible(viewOf(running(1), { mode: 'off' }))).toBe(false)
  })
})

describe('the strip as text', () => {
  it('draws the main loop handing work to each running sub-agent', () => {
    const line = plain(bandLine(viewOf(running(2)), 100))

    expect(line).toMatch(/^[◐◓◑◒] tokensaver main ─▸ haiku search part 1 .* ─▸ haiku search part 2/u)
  })

  it('shows three at most and counts the rest', () => {
    const line = plain(bandLine(viewOf(running(5)), 100))

    expect(line.match(/─▸/gu)).toHaveLength(3)
    expect(line).toMatch(/\+2$/u)
  })

  it('shows the newest event when nothing is running', () => {
    expect(plain(bandLine(flashing(), 100))).toMatch(/^● tokensaver ✓ find all usages.* done · 4\.2k on haiku$/u)
  })

  it('turns its spinner with the frame, and holds still under reduced motion', () => {
    const view = viewOf(running(1))

    expect(plain(bandLine({ ...view, frame: 0 }, 80))).not.toBe(plain(bandLine({ ...view, frame: 1 }, 80)))

    const still = viewOf(running(1, { reducedMotion: true }))

    expect(plain(bandLine({ ...still, frame: 0 }, 80))).toBe(plain(bandLine({ ...still, frame: 1 }, 80)))
  })

  it('colours the tier, and carries no colour under NO_COLOR', () => {
    const tones = bandLine(viewOf(running(1)), 80).flatMap(part => (part.tone === undefined ? [] : [part.tone]))

    expect(tones).toContain('success')

    for (const part of bandLine(viewOf(running(1), { hasNoColor: true }), 80)) {
      expect(part).not.toHaveProperty('tone')
    }
  })

  it('labels an agent whose model it does not know as inheriting', () => {
    const view = viewOf(running(1))
    const agents = view.band.agents.map(agent => ({ ...agent, tier: undefined }))

    expect(plain(bandLine({ ...view, band: { ...view.band, agents } }, 80))).toContain('─▸ inherit ')
  })
})

describe('the strip as an animated picture', () => {
  it('is one well-formed SVG of the size asked for', () => {
    const svg = bandSvg(viewOf(running(2)), 640)

    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 30" width="640" height="30">')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(BAND_HEIGHT).toBe(30)
    expect(svg.match(/<svg/g)).toHaveLength(1)
  })

  it('draws a pill and a flowing line for each running sub-agent', () => {
    const svg = bandSvg(viewOf(running(2)), 640)

    expect(svg.match(/stroke-dasharray/g)).toHaveLength(2)
    expect(svg.match(/attributeName="stroke-dashoffset"/g)).toHaveLength(2)
    expect(svg).toContain('haiku · search part 1')
    expect(svg).toContain('haiku · search part 2')
  })

  it('escapes text it did not write', () => {
    const svg = bandSvg(viewOf(running(1)), 640)

    expect(svg).toContain('&lt;fast&gt;')
    expect(svg).not.toContain('<fast>')
  })

  it('carries no script, link or event handler', () => {
    for (const svg of [bandSvg(viewOf(running(3)), 640), bandSvg(flashing(), 640)]) {
      expect(svg).not.toMatch(/<script|href=|\son[a-z]+=|javascript:/i)
    }
  })

  it('follows the app light or dark, with no background of its own', () => {
    const svg = bandSvg(viewOf(running(1)), 640)

    expect(svg).toContain('@media (prefers-color-scheme: dark)')
    expect(svg).not.toMatch(/<rect[^>]*width="640"/)
  })

  it('animates while a sub-agent runs, and not at all under reduced motion', () => {
    expect(bandSvg(viewOf(running(1)), 640)).toContain('<animate')
    expect(bandSvg(viewOf(running(1, { reducedMotion: true })), 640)).not.toContain('<animate')
    expect(bandSvg(flashing({ hasReducedMotion: true }), 640)).not.toContain('<animate')
  })

  it('uses tier colours, and only the text colour under NO_COLOR', () => {
    expect(bandSvg(viewOf(running(1)), 640)).toContain('#3fa55b')

    const mono = bandSvg(viewOf(running(1), { hasNoColor: true }), 640)

    expect(mono).not.toMatch(/(?:fill|stroke)="#/)
    expect(mono).toContain('haiku · search part 1')
  })

  it('marks a retry in the warning colour', () => {
    const view = viewOf(running(1))
    const agents = view.band.agents.map(agent => ({ ...agent, status: 'retrying' as const }))

    expect(bandSvg({ ...view, band: { ...view.band, agents } }, 640)).toContain('#d99a00')
  })

  it('shows the newest event with a fade when nothing is running', () => {
    const svg = bandSvg(flashing(), 640)

    expect(svg).toContain('✓ find all usages')
    expect(svg).toContain('attributeName="opacity" values="0;1"')
    expect(svg).not.toContain('stroke-dasharray')
  })

  it('shows the saved total only where there is room', () => {
    expect(bandSvg(viewOf(running(1)), 900)).toContain('saved ~')
    expect(bandSvg(viewOf(running(3)), 300)).not.toContain('saved ~')
  })

  it('counts the sub-agents it has no room to draw', () => {
    expect(bandSvg(viewOf(running(5)), 1200)).toContain('>+2<')
  })
})

describe('the spinner', () => {
  it('says how many sub-agents are running and on what', () => {
    expect(spinnerSuffix(viewOf(running(1)))).toBe(' · 1 sub-agent on haiku')
    expect(spinnerSuffix(viewOf(running(3)))).toBe(' · 3 sub-agents on haiku')
  })

  it('is left alone when none is running or tokensaver is off', () => {
    expect(spinnerSuffix(viewOf(startSession()))).toBeUndefined()
    expect(spinnerSuffix(viewOf(running(1), { mode: 'off' }))).toBeUndefined()
  })
})

describe('the mark on a sub-agent row', () => {
  it('marks a call tokensaver routed, with its tier and kind of task', () => {
    const badge = routedBadge(viewOf(running(1)), 'call-1')

    expect(badge === undefined ? '' : plain(badge)).toBe('◆ tokensaver → haiku (search)')
  })

  it('marks an escalated call with where it came from', () => {
    const stream = new Stream(startSession())

    stream.runAgent({
      toolUseId: 'call-1',
      prompt: SEARCH_PROMPT,
      results: [{ text: '', isError: true }, { text: 'ok' }],
    })

    const badge = routedBadge(viewOf(stream.session), 'call-1')

    expect(badge === undefined ? '' : plain(badge)).toBe('◆ tokensaver haiku ↑ sonnet (search)')
  })

  it('leaves alone a call it did not route, and one it has never seen', () => {
    const stream = new Stream(startSession({ dryRun: true }))

    stream.runAgent({ toolUseId: 'call-1', prompt: SEARCH_PROMPT, results: [{ text: 'ok' }] })

    expect(routedBadge(viewOf(stream.session), 'call-1')).toBeUndefined()
    expect(routedBadge(viewOf(running(1)), 'someone-else')).toBeUndefined()
  })
})
