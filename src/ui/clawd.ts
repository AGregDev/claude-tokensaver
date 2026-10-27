/**
 * Clawd, drawn. A pixel-art vector with a CSS animation per mood for surfaces
 * that draw SVG (the desktop app), and block-glyph art for the terminal.
 * Every picture is a pure function of a ClawdView, so the same state always
 * draws the same markup and a redraw with nothing new does not restart it.
 */
import type { FeedItem, FeedKind, Mood } from '../runtime/assistant.ts'
import { bar, fit, formatTokens } from './format.ts'
import type { Line, Tone } from './theme.ts'

export type ClawdView = {
  mood: Mood
  speech: string
  mode: 'on' | 'off' | 'dry-run'
  hasMotion: boolean
  hasColor: boolean
  /** No glyph art and no passing moods: plain words, shown only when the person can act. */
  isQuiet: boolean
  context: { tokens: number; window: number; percent: number }
  /** Tokens Clawd cut that would otherwise sit in the context right now. */
  ghost: number
  stats: {
    eaten: number
    reReads: number
    compactFreed: number
    routed: number
    keptOut: number
    trims: number
    compactions: number
  }
  feed: readonly FeedItem[]
  activeAgents: number
  frame: number
}

const ORANGE = '#D97757'
const ORANGE_DARK = '#B85C3E'
const INK = '#1F1A17'

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Splits text into lines of at most `width` characters, breaking at spaces. */
export const wrap = (text: string, width: number, maxLines: number): string[] => {
  const words = text.split(/\s+/).filter(word => word !== '')
  const lines: string[] = []
  let line = ''

  for (const word of words) {
    const candidate = line === '' ? word : `${line} ${word}`

    if (candidate.length <= width) {
      line = candidate
      continue
    }

    if (line !== '') {
      lines.push(line)
    }

    line = word.length > width ? fit(word, width) : word
  }

  if (line !== '') {
    lines.push(line)
  }

  if (lines.length <= maxLines) {
    return lines
  }

  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = fit(`${kept[maxLines - 1] ?? ''} …`, width)

  return kept
}

// --- The vector ------------------------------------------------------------

/**
 * The stylesheet every Clawd picture shares. Animations are keyed by the mood
 * class on the root group, so one body serves every mood.
 */
const STYLE = (hasMotion: boolean): string => `<style>
svg{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.t{fill:#3b3530}
.d{fill:#8a817a}
.bubble{fill:#ffffff;stroke:#e6ddd6}
.track{fill:#efe8e2}
.tile{fill:#faf6f3;stroke:#eee5de}
@media (prefers-color-scheme:dark){
.t{fill:#ece6e1}.d{fill:#a59d96}.bubble{fill:#2b2724;stroke:#3d3733}.track{fill:#3a3430}.tile{fill:#262220;stroke:#352f2b}
}
.c *{transform-box:fill-box;transform-origin:center}
${
  hasMotion
    ? `
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes look{0%,40%,100%{transform:translateX(0)}50%,90%{transform:translateX(5px)}}
@keyframes walkA{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes walkB{0%,100%{transform:translateY(-4px)}50%{transform:translateY(0)}}
@keyframes jump{0%,100%{transform:translateY(0)}30%{transform:translateY(-16px) scaleY(1.04)}55%{transform:translateY(0) scaleY(.92)}70%{transform:translateY(-4px)}}
@keyframes chomp{0%,100%{transform:scaleY(.15)}50%{transform:scaleY(1)}}
@keyframes crumb{0%{transform:translate(0,0) scale(1);opacity:0}15%{opacity:1}100%{transform:translate(-78px,6px) scale(.3);opacity:0}}
@keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-2px)}40%{transform:translateX(2px)}60%{transform:translateX(-1px)}80%{transform:translateX(1px)}}
@keyframes drip{0%{transform:translateY(0);opacity:0}20%{opacity:1}100%{transform:translateY(18px);opacity:0}}
@keyframes zzz{0%{transform:translate(0,0) scale(.6);opacity:0}30%{opacity:1}100%{transform:translate(14px,-26px) scale(1.15);opacity:0}}
@keyframes spark{0%,100%{transform:scale(0) rotate(0);opacity:0}40%{transform:scale(1) rotate(45deg);opacity:1}70%{opacity:.8}}
@keyframes pop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
@keyframes breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(.96)}}
@keyframes flow{from{background-position:0 0}to{background-position:12px 0}}
@keyframes dash{to{stroke-dashoffset:-12}}
.idle .whole{animation:bob 2.8s ease-in-out infinite}
.idle .eyes,.busy .eyes,.happy .eyes,.chomp .eyes{animation:blink 4.2s infinite}
.busy .whole{animation:bob 1.1s ease-in-out infinite}
.busy .pupils{animation:look 2.4s ease-in-out infinite}
.busy .legA{animation:walkA .5s steps(2) infinite}
.busy .legB{animation:walkB .5s steps(2) infinite}
.happy .whole{animation:jump 1.2s ease-out infinite}
.happy .spark{animation:spark 1.2s ease-out infinite}
.chomp .whole{animation:bob .45s ease-in-out infinite}
.chomp .mouth{animation:chomp .3s ease-in-out infinite}
.chomp .crumb{animation:crumb 1.1s linear infinite}
.worried .whole{animation:shake .9s ease-in-out infinite}
.worried .drop{animation:drip 1.6s ease-in infinite}
.sleepy .whole{animation:breathe 3.6s ease-in-out infinite}
.sleepy .z{animation:zzz 2.7s ease-out infinite}
.alert .whole{animation:shake .4s ease-in-out infinite}
.alert .bang{animation:pop .5s ease-out both}
.pop{animation:pop .45s ease-out both}
.flowing{animation:dash .8s linear infinite}
`
    : ''
}</style>`

const rect = (x: number, y: number, w: number, h: number, p: number, fill: string, cls = ''): string =>
  `<rect${cls === '' ? '' : ` class="${cls}"`} x="${String(x * p)}" y="${String(y * p)}" width="${String(w * p)}" height="${String(h * p)}" fill="${fill}"/>`

/**
 * Clawd's body on a 14 x 10 pixel grid, `p` CSS pixels a cell, with the parts
 * each mood moves: eyes, pupils, mouth, legs, and the mood's own props.
 */
export const clawdBody = (mood: Mood, p: number): string => {
  const body = mood === 'off' ? '#9b948e' : ORANGE
  const shade = mood === 'off' ? '#86807a' : ORANGE_DARK
  const isClosed = mood === 'sleepy' || mood === 'off'
  const eyes = isClosed
    ? `<g class="eyes">${rect(3.6, 3.2, 1.6, 0.45, p, INK)}${rect(8.8, 3.2, 1.6, 0.45, p, INK)}</g>`
    : `<g class="eyes"><g class="pupils">${rect(4, 2, 1, 2, p, INK)}${rect(9, 2, 1, 2, p, INK)}</g></g>`
  const props: string[] = []

  switch (mood) {
    case 'chomp':
      props.push(
        `<g class="mouth">${rect(5.5, 5, 3, 1.2, p, INK)}</g>`,
        ...[0, 1, 2, 3].map(
          index =>
            `<g class="crumb" style="animation-delay:${String(index * 0.27)}s">${rect(17 + (index % 2), 4.3 + (index % 3) * 0.5, 0.9, 0.9, p, index % 2 === 0 ? '#7B83EB' : '#3FA55B')}</g>`,
        ),
      )
      break
    case 'worried':
      props.push(
        `<path class="drop" d="M${String(12.4 * p)} ${String(0.2 * p)} q${String(0.7 * p)} ${String(1.1 * p)} 0 ${String(1.6 * p)} q${String(-0.7 * p)} ${String(-0.5 * p)} 0 ${String(-1.6 * p)}z" fill="#6FB7E9"/>`,
      )
      break
    case 'sleepy':
      props.push(
        ...['z', 'z', 'Z'].map(
          (letter, index) =>
            `<text class="t z" x="${String(12.5 * p)}" y="${String(0.5 * p)}" font-size="${String(1.4 * p + index * 2)}" font-weight="700" style="animation-delay:${String(index * 0.9)}s">${letter}</text>`,
        ),
      )
      break
    case 'happy':
      props.push(
        ...[
          [-1.5, 0.5],
          [14.3, 1],
          [0, -1.8],
          [13, -1.5],
        ].map(
          ([x = 0, y = 0], index) =>
            `<path class="spark" style="animation-delay:${String(index * 0.18)}s" transform="translate(${String(x * p)} ${String(y * p)})" d="M0 -${String(p)} L${String(p * 0.28)} -${String(p * 0.28)} L${String(p)} 0 L${String(p * 0.28)} ${String(p * 0.28)} L0 ${String(p)} L-${String(p * 0.28)} ${String(p * 0.28)} L-${String(p)} 0 L-${String(p * 0.28)} -${String(p * 0.28)}Z" fill="#F2B84B"/>`,
        ),
      )
      break
    case 'alert':
      props.push(
        `<text class="t bang" x="${String(6.2 * p)}" y="${String(-0.6 * p)}" font-size="${String(2.6 * p)}" font-weight="800" fill="#E5484D" style="fill:#E5484D">!</text>`,
      )
      break
    case 'idle':
    case 'busy':
    case 'off':
      break
  }

  return [
    `<ellipse cx="${String(7 * p)}" cy="${String(10.4 * p)}" rx="${String(5.5 * p)}" ry="${String(0.55 * p)}" fill="#000" opacity=".12"/>`,
    '<g class="whole">',
    `<g class="legA">${rect(3, 8, 1, 2, p, shade)}${rect(8, 8, 1, 2, p, shade)}</g>`,
    `<g class="legB">${rect(5, 8, 1, 2, p, shade)}${rect(10, 8, 1, 2, p, shade)}</g>`,
    rect(2, 0, 10, 8, p, body),
    rect(0, 4, 2, 2, p, body),
    rect(12, 4, 2, 2, p, body),
    rect(2, 7, 10, 1, p, shade),
    eyes,
    ...props,
    '</g>',
  ].join('')
}

const KIND_COLORS: Readonly<Record<FeedKind, string>> = {
  trim: '#3FA55B',
  paste: '#3FA55B',
  compact: '#7B83EB',
  cold: '#6FB7E9',
  warn: '#D99A00',
  route: '#3FA55B',
  escalate: '#E5484D',
  info: '#8B8B8B',
}

const fillColor = (percent: number): string => {
  if (percent >= 85) {
    return '#E5484D'
  }

  return percent >= 70 ? '#D99A00' : ORANGE
}

/**
 * The pane's hero: Clawd, a speech bubble, and the context meter, which also
 * shows as a hatched ghost what the context would hold without the trims.
 */
export const heroSvg = (view: ClawdView, width: number): string => {
  const w = Math.max(300, Math.round(width))
  const p = 7
  const clawdX = 18
  const clawdY = 30
  const bubbleX = clawdX + 14 * p + 26
  const bubbleW = w - bubbleX - 10
  const lines = wrap(view.speech, Math.max(16, Math.floor((bubbleW - 28) / 7.1)), 4)
  const bubbleH = Math.max(46, lines.length * 18 + 22)
  const bubbleY = Math.max(10, 58 - bubbleH / 2)
  const meterY = 132
  const meterW = w - 36
  const { percent, tokens, window } = view.context
  const fillW = window <= 0 ? 0 : Math.min(meterW, (tokens / window) * meterW)
  const ghostW = window <= 0 ? 0 : Math.min(meterW - fillW, (view.ghost / window) * meterW)
  const height = meterY + 44
  const tail = `M${String(bubbleX)} ${String(bubbleY + bubbleH / 2 - 8)} L${String(bubbleX - 12)} ${String(bubbleY + bubbleH / 2 + 2)} L${String(bubbleX)} ${String(bubbleY + bubbleH / 2 + 8)}`
  const label =
    window <= 0
      ? 'Context: waiting for the first reply'
      : `Context ${String(percent)}%  ·  ${formatTokens(tokens)} of ${formatTokens(window)}`

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(height)}" viewBox="0 0 ${String(w)} ${String(height)}">`,
    STYLE(view.hasMotion),
    '<defs>',
    `<linearGradient id="fill" x1="0" x2="1"><stop offset="0" stop-color="${ORANGE}"/><stop offset="1" stop-color="${fillColor(percent)}"/></linearGradient>`,
    '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#3FA55B" opacity=".55"/></pattern>',
    '</defs>',
    `<g class="c ${view.mood}" transform="translate(${String(clawdX)} ${String(clawdY)})">${clawdBody(view.mood, p)}</g>`,
    `<g class="pop">`,
    `<rect class="bubble" x="${String(bubbleX)}" y="${String(bubbleY)}" width="${String(bubbleW)}" height="${String(bubbleH)}" rx="14" stroke-width="1.5"/>`,
    `<path class="bubble" d="${tail}" stroke-width="1.5"/>`,
    `<rect class="bubble" x="${String(bubbleX - 1)}" y="${String(bubbleY + bubbleH / 2 - 7)}" width="4" height="14" stroke="none"/>`,
    ...lines.map(
      (line, index) =>
        `<text class="t" x="${String(bubbleX + 14)}" y="${String(bubbleY + 25 + index * 18)}" font-size="13">${escape(line)}</text>`,
    ),
    '</g>',
    `<text class="t" x="18" y="${String(meterY - 8)}" font-size="12" font-weight="600">${escape(label)}</text>`,
    view.ghost > 0
      ? `<text class="d" x="${String(w - 18)}" y="${String(meterY - 8)}" font-size="11" text-anchor="end">hatched: ${formatTokens(view.ghost)} Clawd kept out</text>`
      : '',
    `<rect class="track" x="18" y="${String(meterY)}" width="${String(meterW)}" height="12" rx="6"/>`,
    `<rect x="18" y="${String(meterY)}" width="${Math.max(fillW, window > 0 ? 6 : 0).toFixed(1)}" height="12" rx="6" fill="url(#fill)"/>`,
    ghostW > 1
      ? `<rect x="${(18 + fillW).toFixed(1)}" y="${String(meterY)}" width="${ghostW.toFixed(1)}" height="12" rx="3" fill="url(#hatch)"/>`
      : '',
    ...[50, 70, 85].map(mark => {
      const x = 18 + (meterW * mark) / 100

      return `<rect x="${x.toFixed(1)}" y="${String(meterY - 2)}" width="1" height="16" fill="#8b8b8b" opacity=".35"/>`
    }),
    `<text class="d" x="18" y="${String(meterY + 28)}" font-size="11">${escape(
      view.context.percent >= 70
        ? 'Past 70%: every request is heavy. Compact to lighten it.'
        : 'Marks at 50 · 70 · 85%. Clawd speaks up as you cross them.',
    )}</text>`,
    '</svg>',
  ].join('')
}

type Tile = { value: string; label: string; color: string; hint: string }

/** The savings, as tiles: what was eaten, what re-sending that avoided, what compaction freed, what routing saved. */
export const tilesSvg = (view: ClawdView, width: number): string => {
  const w = Math.max(300, Math.round(width))
  const tiles: Tile[] = [
    {
      value: formatTokens(view.stats.eaten),
      label: 'noise eaten',
      color: '#3FA55B',
      hint: `${String(view.stats.trims)} outputs trimmed`,
    },
    {
      value: formatTokens(view.stats.reReads),
      label: 're-sends avoided',
      color: '#7B83EB',
      hint: 'trimmed tokens × later requests',
    },
    {
      value: formatTokens(view.stats.compactFreed),
      label: 'freed by compacting',
      color: ORANGE,
      hint: `${String(view.stats.compactions)} compaction${view.stats.compactions === 1 ? '' : 's'}`,
    },
    {
      value: formatTokens(view.stats.routed + view.stats.keptOut),
      label: 'routing & delegation',
      color: '#D99A00',
      hint: 'cheaper models for helpers',
    },
  ]
  const columns = w >= 560 ? 4 : 2
  const gap = 10
  const tileW = (w - gap * (columns - 1)) / columns
  const tileH = 70
  const rows = Math.ceil(tiles.length / columns)
  const height = rows * tileH + (rows - 1) * gap

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(height)}" viewBox="0 0 ${String(w)} ${String(height)}">`,
    STYLE(view.hasMotion),
    ...tiles.map((tile, index) => {
      const x = (index % columns) * (tileW + gap)
      const y = Math.floor(index / columns) * (tileH + gap)

      return [
        `<g class="pop" style="animation-delay:${String(index * 0.06)}s"><title>${escape(tile.hint)}</title>`,
        `<rect class="tile" x="${x.toFixed(1)}" y="${String(y)}" width="${tileW.toFixed(1)}" height="${String(tileH)}" rx="12"/>`,
        `<rect x="${(x + 12).toFixed(1)}" y="${String(y + 14)}" width="4" height="${String(tileH - 28)}" rx="2" fill="${tile.color}"/>`,
        `<text class="t" x="${(x + 26).toFixed(1)}" y="${String(y + 36)}" font-size="22" font-weight="700">${escape(tile.value)}</text>`,
        `<text class="d" x="${(x + 26).toFixed(1)}" y="${String(y + 55)}" font-size="11.5">${escape(tile.label)}</text>`,
        '</g>',
      ].join('')
    }),
    '</svg>',
  ].join('')
}

/** The strip above the prompt: a small Clawd, what it just did, and the context fill. */
export const bandSvgOf = (view: ClawdView, width: number): string => {
  const w = Math.max(240, Math.round(width))
  const p = 3.4
  const h = 46
  const textX = 14 * p + 30
  const pillW = 86
  const text = fit(view.speech, Math.max(10, Math.floor((w - textX - pillW - 24) / 6.9)))
  const { percent } = view.context

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="${String(h)}" viewBox="0 0 ${String(w)} ${String(h)}">`,
    STYLE(view.hasMotion),
    `<g class="c ${view.mood}" transform="translate(12 6)">${clawdBody(view.mood, p)}</g>`,
    `<text class="t pop" x="${String(textX)}" y="${String(h / 2 + 4.5)}" font-size="13">${escape(text)}</text>`,
    view.context.window > 0
      ? [
          `<rect class="track" x="${String(w - pillW - 8)}" y="${String(h / 2 - 9)}" width="${String(pillW)}" height="18" rx="9"/>`,
          `<rect x="${String(w - pillW - 8)}" y="${String(h / 2 - 9)}" width="${Math.max(18, (pillW * percent) / 100).toFixed(1)}" height="18" rx="9" fill="${fillColor(percent)}" opacity=".85"/>`,
          `<text class="t" x="${String(w - 8 - pillW / 2)}" y="${String(h / 2 + 4)}" font-size="11" font-weight="700" text-anchor="middle">ctx ${String(percent)}%</text>`,
        ].join('')
      : '',
    '</svg>',
  ].join('')
}

export const feedColor = (kind: FeedKind): string => KIND_COLORS[kind]

// --- The terminal ----------------------------------------------------------

const ART: Readonly<Record<Mood, readonly [string, string, string]>> = {
  idle: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  busy: [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▝▘ ▘▝  '],
  happy: [' ▐▛███▜▌ ', '▝▜█▄▄▄█▛▘', '  ▘▘ ▝▝  '],
  chomp: [' ▐▛███▜▌ ', '▝▜██▀██▛▘', '  ▘▘ ▝▝  '],
  worried: [' ▐▛███▜▌▖', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  sleepy: [' ▐▄███▄▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  alert: [' ▐▛███▜▌!', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  off: [' ▐▄███▄▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
}

const BLINK = ' ▐█████▌ '

/** Clawd in block glyphs, three rows; blinks now and then while motion is on. */
export const clawdArt = (view: ClawdView): readonly [string, string, string] => {
  const art = ART[view.mood]
  const isBlinking = view.hasMotion && view.mood !== 'sleepy' && view.mood !== 'off' && view.frame % 16 === 15

  return isBlinking ? [BLINK, art[1], art[2]] : art
}

const CHOMP_TRAIL = ['◂ ▪ ▪ ▪', '◂▪ ▪ ▪ ', '◂ ▪ ▪  ', '◂▪ ▪   ']

const toneOf = (view: ClawdView, tone: Tone): { tone?: Tone } => (view.hasColor ? { tone } : {})

const moodTone = (mood: Mood): Tone => {
  switch (mood) {
    case 'worried':
      return 'warning'
    case 'alert':
      return 'error'
    case 'off':
    case 'sleepy':
      return 'inactive'
    case 'happy':
    case 'chomp':
      return 'success'
    case 'idle':
    case 'busy':
      return 'claude'
  }
}

/**
 * Whether the strip above the prompt shows, and whether it offers to compact.
 * Quiet, it shows only for the offer: no passing mood, helper band or flash.
 */
export const stripOf = (
  view: ClawdView,
  input: { isFlaring: boolean; hasAgents: boolean; hasFlash: boolean },
): { isVisible: boolean; shouldOffer: boolean } => {
  const shouldOffer = view.mood === 'sleepy' || (view.mood === 'worried' && view.context.percent >= 70)
  const isLively = !view.isQuiet && (input.isFlaring || input.hasAgents || input.hasFlash)

  return { isVisible: view.mode !== 'off' && (shouldOffer || isLively), shouldOffer }
}

/** The strip above the prompt, in the terminal: one line. Quiet, no glyph face. */
export const bandLineOf = (view: ClawdView, columns: number): Line => {
  if (view.isQuiet) {
    const label = 'tokensaver '
    const meter = view.context.window > 0 ? ` (${String(view.context.percent)}%)` : ''

    return [
      { text: label, isDim: true },
      { text: fit(view.speech, Math.max(10, columns - label.length - meter.length - 1)), ...toneOf(view, moodTone(view.mood)) },
      { text: meter, isDim: true },
    ]
  }

  const face = view.mood === 'sleepy' ? '▐▄█▄▌' : view.mood === 'chomp' ? '▐▛▀▜▌' : '▐▛█▜▌'
  const trail = view.mood === 'chomp' && view.hasMotion ? ` ${CHOMP_TRAIL[view.frame % CHOMP_TRAIL.length] ?? ''}` : ''
  const meter =
    view.context.window > 0 ? ` ${bar(view.context.percent / 100, 8)} ${String(view.context.percent)}%` : ''
  const room = Math.max(10, columns - face.length - trail.length - meter.length - 3)

  return [
    { text: face, ...toneOf(view, 'claude') },
    { text: trail, ...toneOf(view, 'success'), isDim: true },
    { text: ` ${fit(view.speech, room)}`, ...toneOf(view, moodTone(view.mood)) },
    { text: meter, isDim: true },
  ]
}

/** The speech bubble beside the art in a terminal pane, three rows to match it. */
export const bubbleRows = (view: ClawdView, columns: number): readonly string[] => {
  const width = Math.max(14, columns - 14)
  const lines = wrap(view.speech, width - 4, 3)

  while (lines.length < 3) {
    lines.push('')
  }

  return lines.map((line, index) => `${index === 1 ? '◀ ' : '  '}${line}`)
}
