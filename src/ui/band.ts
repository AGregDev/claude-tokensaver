/**
 * The strip above the prompt: who is working for whom, right now. It shows
 * while a sub-agent runs and for a few seconds after an event, and is gone
 * the rest of the time. Text for the terminal, an animated vector for
 * surfaces that draw one.
 */
import type { Tier } from '../core/tiers.ts'
import type { FlashTone } from '../runtime/session.ts'
import { fit, formatTokens, spinner } from './format.ts'
import { span } from './theme.ts'
import type { Line, Tone } from './theme.ts'
import { themeOf } from './view.ts'
import type { View, ViewAgent } from './view.ts'

const TIER_TONES: Readonly<Record<Tier, Tone>> = {
  haiku: 'success',
  sonnet: 'suggestion',
  opus: 'claude',
}

const FLASH_TONES: Readonly<Record<FlashTone, Tone>> = {
  route: 'success',
  escalate: 'warning',
  done: 'success',
  fail: 'error',
  info: 'suggestion',
}

const FLASH_GLYPHS: Readonly<Record<FlashTone, string>> = {
  route: '→',
  escalate: '↑',
  done: '✓',
  fail: '✗',
  info: '·',
}

/** Colours that read on a light and on a dark background alike. */
const HEX: Readonly<Record<Tone, string>> = {
  success: '#3fa55b',
  suggestion: '#7b83eb',
  claude: '#d77757',
  warning: '#d99a00',
  error: '#e5484d',
  inactive: '#8b8b8b',
}

const MAX_SHOWN = 3
const LABEL_CHARS = 22

/** True when the strip has something to say. */
export const isBandVisible = (view: View): boolean =>
  view.mode !== 'off' && (view.band.agents.length > 0 || view.band.flash !== undefined)

const tierName = (agent: ViewAgent): string => agent.tier ?? 'inherit'

/** The strip as one line of text. */
export const bandLine = (view: View, columns: number): Line => {
  const theme = themeOf(view)
  const { agents, flash } = view.band
  const isActive = agents.length > 0
  const parts = [
    span(theme, `${isActive ? spinner(view.frame, theme.hasMotion) : '●'} `, { tone: 'claude' }),
    span(theme, 'tokensaver ', { isBold: true }),
  ]

  if (isActive) {
    parts.push(span(theme, 'main', { isDim: true }))

    for (const agent of agents.slice(0, MAX_SHOWN)) {
      parts.push(
        span(theme, ' ─▸ ', { isDim: true }),
        span(theme, tierName(agent), agent.tier === undefined ? {} : { tone: TIER_TONES[agent.tier] }),
        span(theme, ` ${fit(agent.label, LABEL_CHARS)}`),
      )
    }

    if (agents.length > MAX_SHOWN) {
      parts.push(span(theme, `  +${String(agents.length - MAX_SHOWN)}`, { isDim: true }))
    }
  } else if (flash !== undefined) {
    parts.push(
      span(theme, `${FLASH_GLYPHS[flash.tone]} `, { tone: FLASH_TONES[flash.tone] }),
      span(theme, fit(flash.text, Math.max(20, columns - 16))),
    )
  }

  return parts
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STYLE =
  '<style>' +
  'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:11.5px}' +
  '.ink{fill:#2b2a27}.dim{fill:#77756f}.rail{stroke:#77756f}' +
  '@media (prefers-color-scheme: dark){.ink{fill:#ecebe6}.dim{fill:#9c9a92}.rail{stroke:#9c9a92}}' +
  '</style>'

/** Approximate width of proportional text at the strip's font size. */
const textWidth = (text: string): number => Math.ceil(text.length * 6.1)

const HEIGHT = 30
const MID = HEIGHT / 2

/**
 * The strip as an animated SVG picture: the main loop on the left, a dashed
 * line flowing out to each running sub-agent, each agent a pill in its
 * tier's colour with a pulsing dot. Under reduced motion nothing moves, and
 * under NO_COLOR everything is drawn in the text colour.
 */
export const bandSvg = (view: View, width: number): string => {
  const theme = themeOf(view)
  const { agents, flash } = view.band
  const colour = (tone: Tone): string => (theme.hasColor ? `fill="${HEX[tone]}"` : 'class="ink"')
  const stroke = (tone: Tone): string => (theme.hasColor ? `stroke="${HEX[tone]}"` : 'class="rail"')
  const moving = (markup: string): string => (theme.hasMotion ? markup : '')
  const parts: string[] = [STYLE]
  const isActive = agents.length > 0

  // The main loop.
  parts.push(
    `<circle cx="12" cy="${String(MID)}" r="9" ${colour('claude')} opacity="0.18">${moving(
      isActive
        ? '<animate attributeName="r" values="6;11;6" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.3;0.05;0.3" dur="1.6s" repeatCount="indefinite"/>'
        : '',
    )}</circle>`,
    `<circle cx="12" cy="${String(MID)}" r="4.5" ${colour('claude')}/>`,
    `<text x="24" y="${String(MID + 4)}" class="ink" font-weight="600">tokensaver</text>`,
  )

  let x = 24 + textWidth('tokensaver') + 14

  if (isActive) {
    agents.slice(0, MAX_SHOWN).forEach((agent, index) => {
      const tone: Tone = agent.status === 'retrying' ? 'warning' : agent.tier === undefined ? 'inactive' : TIER_TONES[agent.tier]
      const label = `${tierName(agent)} · ${fit(agent.label, LABEL_CHARS)}`
      const pill = textWidth(label) + 30
      const rail = 26
      const delay = (index * 0.25).toFixed(2)

      // The line the work flows along.
      parts.push(
        `<line x1="${String(x)}" y1="${String(MID)}" x2="${String(x + rail)}" y2="${String(MID)}" ${stroke(tone)} stroke-width="1.6" stroke-dasharray="4 4" stroke-linecap="round" fill="none">${moving(
          `<animate attributeName="stroke-dashoffset" from="8" to="0" dur="0.6s" begin="${delay}s" repeatCount="indefinite"/>`,
        )}</line>`,
      )
      x += rail + 4

      // The sub-agent.
      parts.push(
        `<rect x="${String(x)}" y="5" width="${String(pill)}" height="20" rx="10" ${colour(tone)} opacity="0.16"/>`,
        `<rect x="${String(x)}" y="5" width="${String(pill)}" height="20" rx="10" fill="none" ${stroke(tone)} stroke-width="1"/>`,
        `<circle cx="${String(x + 12)}" cy="${String(MID)}" r="3.5" ${colour(tone)}>${moving(
          `<animate attributeName="opacity" values="1;0.25;1" dur="1.1s" begin="${delay}s" repeatCount="indefinite"/>`,
        )}</circle>`,
        `<text x="${String(x + 21)}" y="${String(MID + 4)}" class="ink">${escapeXml(label)}</text>`,
      )
      x += pill + 8
    })

    if (agents.length > MAX_SHOWN) {
      parts.push(
        `<text x="${String(x + 2)}" y="${String(MID + 4)}" class="dim">+${String(agents.length - MAX_SHOWN)}</text>`,
      )
      x += 30
    }
  } else if (flash !== undefined) {
    const tone = FLASH_TONES[flash.tone]
    const text = `${FLASH_GLYPHS[flash.tone]} ${fit(flash.text, 70)}`

    parts.push(
      `<text x="${String(x)}" y="${String(MID + 4)}" ${colour(tone)}>${escapeXml(text)}${moving(
        '<animate attributeName="opacity" values="0;1" dur="0.35s" fill="freeze"/>',
      )}</text>`,
    )
    x += textWidth(text) + 12
  }

  // The running total, where there is room for it.
  const total = `saved ~${formatTokens(view.hasReducedMotion ? view.saved : view.shownSaved)}`

  if (x + textWidth(total) + 8 <= width) {
    parts.push(
      `<text x="${String(width - 6)}" y="${String(MID + 4)}" text-anchor="end" class="dim">${escapeXml(total)}</text>`,
    )
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(HEIGHT)}" width="${String(width)}" height="${String(HEIGHT)}">${parts.join('')}</svg>`
}

export const BAND_HEIGHT = HEIGHT

/** What to add after the spinner's word while sub-agents run, or undefined to leave it alone. */
export const spinnerSuffix = (view: View): string | undefined => {
  const { agents } = view.band

  if (view.mode === 'off' || agents.length === 0) {
    return undefined
  }

  const tiers = [...new Set(agents.map(tierName))].join(', ')

  return ` · ${String(agents.length)} sub-agent${agents.length === 1 ? '' : 's'} on ${tiers}`
}

/** A one-line badge for an Agent call tokensaver routed, or undefined when it did not. */
export const routedBadge = (view: View, toolUseId: string): Line | undefined => {
  const agent = view.routed.find(entry => entry.key === toolUseId)

  if (agent?.tier === undefined) {
    return undefined
  }

  const theme = themeOf(view)

  return [
    span(theme, '◆ tokensaver ', { isDim: true }),
    span(theme, agent.escalatedFrom === undefined ? '→ ' : `${agent.escalatedFrom} ↑ `, {
      tone: agent.escalatedFrom === undefined ? TIER_TONES[agent.tier] : 'warning',
    }),
    span(theme, agent.tier, { tone: TIER_TONES[agent.tier], isBold: true }),
    span(theme, ` (${agent.taskType})`, { isDim: true }),
  ]
}
