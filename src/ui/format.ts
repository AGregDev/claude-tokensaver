const SPINNER = ['◐', '◓', '◑', '◒'] as const

/** 1234 -> "1.2k", 950 -> "950". A negative count keeps its sign. */
export const formatTokens = (tokens: number): string => {
  const size = Math.abs(tokens)
  const sign = tokens < 0 ? '-' : ''

  if (size >= 1_000_000) {
    return `${sign}${(size / 1_000_000).toFixed(1)}M`
  }

  return size >= 1000 ? `${sign}${(size / 1000).toFixed(1)}k` : `${sign}${String(Math.round(size))}`
}

/** A fixed-width meter: `fraction` of `width` cells filled. */
export const bar = (fraction: number, width: number): string => {
  const cells = Math.max(1, Math.round(width))
  const ratio = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0
  const filled = Math.round(ratio * cells)

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

/** The spinner glyph for a frame; one fixed glyph when motion is off. */
export const spinner = (frame: number, hasMotion: boolean): string =>
  hasMotion ? (SPINNER[Math.abs(frame) % SPINNER.length] ?? SPINNER[0]) : '◆'

/** Cuts text to a width, marking the cut. */
export const fit = (text: string, width: number): string => {
  if (text.length <= width) {
    return text
  }

  return width <= 1 ? text.slice(0, Math.max(0, width)) : `${text.slice(0, width - 1)}…`
}
