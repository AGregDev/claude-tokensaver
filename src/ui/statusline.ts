import { formatTokens, sparkline, spinner } from './format.ts'
import { themeOf } from './view.ts'
import type { View } from './view.ts'

const SPARK_WIDTH = 8

/** The saved figure on screen: mid-ease while animating, final under reduced motion. */
export const savedOnScreen = (view: View): number =>
  view.hasReducedMotion ? view.saved : view.shownSaved

/**
 * The compact status line for the CLI, or undefined to clear it. Plain text:
 * it carries no colour codes, so NO_COLOR needs nothing more here.
 */
export const renderStatusLine = (view: View): string | undefined => {
  if (view.mode === 'off' || !view.hasStatusLine) {
    return undefined
  }

  const theme = themeOf(view)
  const glyph = view.activeCount > 0 ? spinner(view.frame, theme.hasMotion) : '●'
  const label = view.mode === 'dry-run' ? 'tokensaver [dry-run]' : 'tokensaver'
  const parts = [
    `${glyph} ${label} ${formatTokens(view.total)} tok`,
    `saved ~${formatTokens(savedOnScreen(view))}`,
    `H ${formatTokens(view.spend.haiku)} S ${formatTokens(view.spend.sonnet)} O ${formatTokens(view.spend.opus)}`,
  ]

  if (view.history.length >= 2) {
    parts.push(sparkline(view.history, SPARK_WIDTH))
  }

  if (view.activeCount > 0) {
    parts.push(`${String(view.activeCount)} agent${view.activeCount === 1 ? '' : 's'}`)
  }

  return parts.join(' · ')
}
