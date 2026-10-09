const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const
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

/** The last `width` values as block characters, scaled between their own low and high. */
export const sparkline = (values: readonly number[], width: number): string => {
  const shown = values.slice(-Math.max(1, width))

  if (shown.length === 0) {
    return ''
  }

  const low = Math.min(...shown)
  const range = Math.max(...shown) - low

  return shown
    .map(value => {
      const level = range === 0 ? 0 : Math.round(((value - low) / range) * (BLOCKS.length - 1))

      return BLOCKS[level] ?? BLOCKS[0]
    })
    .join('')
}

/** The spinner glyph for a frame; one fixed glyph when motion is off. */
export const spinner = (frame: number, hasMotion: boolean): string =>
  hasMotion ? (SPINNER[Math.abs(frame) % SPINNER.length] ?? SPINNER[0]) : '◆'

export const padEnd = (text: string, width: number): string =>
  text.length >= width ? text : text + ' '.repeat(width - text.length)

export const padStart = (text: string, width: number): string =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text

/** Cuts text to a width, marking the cut. */
export const fit = (text: string, width: number): string => {
  if (text.length <= width) {
    return text
  }

  return width <= 1 ? text.slice(0, Math.max(0, width)) : `${text.slice(0, width - 1)}…`
}

/**
 * The savings history as a standalone SVG polyline, for surfaces that draw
 * vectors. `currentColor` keeps it readable in any theme and under NO_COLOR.
 */
export const sparklineSvg = (values: readonly number[], width = 240, height = 36): string => {
  // Fewer than two readings draw as a flat line rather than nothing.
  const points = values.length < 2 ? [values[0] ?? 0, values[0] ?? 0] : values
  const low = Math.min(...points)
  const range = Math.max(...points) - low
  const stepX = width / (points.length - 1)
  const path = points
    .map((value, index) => {
      const x = (index * stepX).toFixed(1)
      const y = (height - 2 - (range === 0 ? 0 : ((value - low) / range) * (height - 4))).toFixed(1)

      return `${x},${y}`
    })
    .join(' ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(width)} ${String(height)}" width="${String(width)}" height="${String(height)}"><polyline fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${path}"/></svg>`
}
