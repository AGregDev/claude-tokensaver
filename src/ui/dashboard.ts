import type { Tier } from '../core/tiers.ts'
import type { AgentStatus } from '../runtime/session.ts'
import { bar, fit, formatTokens, padEnd, padStart, sparkline, spinner } from './format.ts'
import { savedOnScreen } from './statusline.ts'
import { span } from './theme.ts'
import type { Line, Theme, Tone } from './theme.ts'
import { themeOf } from './view.ts'
import type { View, ViewAgent } from './view.ts'

const MIN_COLUMNS = 34
const MAX_COLUMNS = 72
const LABEL_WIDTH = 9

const TIER_TONES: Readonly<Record<Tier, Tone>> = {
  haiku: 'success',
  sonnet: 'suggestion',
  opus: 'claude',
}

const STATUS_TONES: Readonly<Record<AgentStatus, Tone>> = {
  running: 'claude',
  retrying: 'warning',
  done: 'success',
  failed: 'error',
  planned: 'inactive',
}

const STATUS_GLYPHS: Readonly<Record<Exclude<AgentStatus, 'running'>, string>> = {
  retrying: '↑',
  done: '✓',
  failed: '✗',
  planned: '○',
}

const MODE_TEXT: Readonly<Record<View['mode'], { glyph: string; word: string; tone: Tone }>> = {
  on: { glyph: '●', word: 'on', tone: 'success' },
  off: { glyph: '○', word: 'off', tone: 'inactive' },
  'dry-run': { glyph: '◌', word: 'dry-run', tone: 'warning' },
}

const widthOf = (columns: number): number =>
  Math.min(MAX_COLUMNS, Math.max(MIN_COLUMNS, Math.floor(columns)))

const heading = (theme: Theme, text: string): Line => [span(theme, text, { isBold: true })]

const headerLine = (view: View, theme: Theme): Line => {
  const mode = MODE_TEXT[view.mode]

  return [
    span(theme, 'tokensaver ', { isBold: true }),
    span(theme, `${mode.glyph} ${mode.word}`, { tone: mode.tone }),
  ]
}

const contextLine = (view: View, theme: Theme, barWidth: number): Line => {
  const { tokens, window } = view.context
  const fraction = window > 0 ? tokens / window : 0
  const tone: Tone = fraction >= 0.85 ? 'error' : fraction >= 0.6 ? 'warning' : 'success'
  const figure =
    window > 0
      ? `${formatTokens(tokens)} / ${formatTokens(window)}  ${String(Math.round(fraction * 100))}%`
      : 'not measured yet'

  return [
    span(theme, padEnd('Context', LABEL_WIDTH)),
    span(theme, bar(fraction, barWidth), { tone }),
    span(theme, `  ${figure}`, { isDim: true }),
  ]
}

const sessionLine = (view: View, theme: Theme): Line => [
  span(theme, padEnd('Session', LABEL_WIDTH)),
  span(theme, `${formatTokens(view.total)} tokens`),
]

const savedLine = (view: View, theme: Theme): Line => [
  span(theme, padEnd('Saved', LABEL_WIDTH)),
  span(theme, `~${formatTokens(savedOnScreen(view))}`, { tone: 'success', isBold: true }),
  span(theme, ' est. by routing', { isDim: true }),
]

const keptOutLine = (view: View, theme: Theme): Line => [
  span(theme, padEnd('Kept out', LABEL_WIDTH)),
  span(theme, formatTokens(view.keptOut), { tone: 'success' }),
  span(theme, ' of main context', { isDim: true }),
]

/** The savings history as one text row: the terminal's sparkline. */
export const sparklineLine = (view: View, columns: number): Line => {
  const theme = themeOf(view)
  const width = widthOf(columns) - LABEL_WIDTH

  return [
    span(theme, padEnd('Trend', LABEL_WIDTH)),
    view.history.length < 2
      ? span(theme, 'builds up over turns', { isDim: true })
      : span(theme, sparkline(view.history, width), { tone: 'success' }),
  ]
}

const tierLines = (view: View, theme: Theme, barWidth: number): readonly Line[] => {
  const rows: readonly (readonly [string, number, Tone | undefined])[] = [
    ['haiku', view.spend.haiku, TIER_TONES.haiku],
    ['sonnet', view.spend.sonnet, TIER_TONES.sonnet],
    ['opus', view.spend.opus, TIER_TONES.opus],
    ...(view.spend.other > 0 ? [['other', view.spend.other, undefined] as const] : []),
  ]
  const peak = Math.max(1, ...rows.map(([, tokens]) => tokens))

  return rows.map(([name, tokens, tone]) => [
    span(theme, `  ${padEnd(name, LABEL_WIDTH - 2)}`),
    span(theme, bar(tokens / peak, barWidth), tone === undefined ? {} : { tone }),
    span(theme, `  ${padStart(formatTokens(tokens), 6)}`, { isDim: true }),
  ])
}

const agentLine = (agent: ViewAgent, view: View, theme: Theme, width: number): Line => {
  const rails = agent.guides.map(hasGuide => (hasGuide ? '│  ' : '   ')).join('')
  const indent = `  ${rails}${agent.isLast ? '└─ ' : '├─ '}`
  const glyph =
    agent.status === 'running'
      ? spinner(view.frame, theme.hasMotion)
      : STATUS_GLYPHS[agent.status]
  const tier = padEnd(agent.tier ?? 'inherit', 7)
  const tokens = padStart(formatTokens(agent.tokens), 6)
  const room = Math.max(8, width - indent.length - 2 - tier.length - 1 - tokens.length - 2)
  const wasOn = agent.escalatedFrom === undefined ? '' : ` (was ${agent.escalatedFrom})`
  // The escalation mark is added after the label is cut, so a long label never hides it;
  // where the row is too narrow for the words, an arrow stands for them.
  const escalation = wasOn === '' || room - wasOn.length >= 10 ? wasOn : ' ↑'

  return [
    span(theme, indent, { isDim: true }),
    span(theme, `${glyph} `, { tone: STATUS_TONES[agent.status] }),
    span(theme, `${tier} `, agent.tier === undefined ? { isDim: true } : { tone: TIER_TONES[agent.tier] }),
    span(theme, padEnd(`${fit(agent.label, room - escalation.length)}${escalation}`, room)),
    span(theme, `  ${tokens}`, { isDim: true }),
  ]
}

const treeLines = (view: View, theme: Theme, width: number): readonly Line[] =>
  view.agents.length === 0
    ? [[span(theme, '  no sub-agents yet', { isDim: true })]]
    : [
        [span(theme, '  main', { isDim: true })],
        ...view.agents.map(agent => agentLine(agent, view, theme, width)),
      ]

const learningLine = (view: View, theme: Theme, width: number): Line => [
  span(theme, padEnd('Learning', LABEL_WIDTH)),
  span(
    theme,
    view.learning.count === 0
      ? 'no outcomes logged yet'
      : fit(
          `${String(view.learning.count)} runs · ${String(Math.round(view.learning.cleanRate * 100))}% clean · ${String(view.learning.escalations)} escalated`,
          width - LABEL_WIDTH,
        ),
    { isDim: true },
  ),
]

export type Dashboard = {
  /** Header, meters and the saved counter, drawn above the savings sparkline. */
  top: readonly Line[]
  /** Per-tier spend, the delegation tree, learning and recent events, drawn below it. */
  bottom: readonly Line[]
}

/**
 * The dashboard as styled lines. The savings sparkline sits between the two
 * halves so each surface can draw it its own way: `sparklineLine` as text on
 * the terminal, `sparklineSvg` as a vector on the desktop.
 */
export const renderDashboard = (view: View, columns: number): Dashboard => {
  const theme = themeOf(view)
  const width = widthOf(columns)
  // The widest row is the context meter: label, bar, then up to 21 cells of figures.
  const barWidth = Math.max(4, Math.min(24, width - LABEL_WIDTH - 21))

  return {
    top: [
      headerLine(view, theme),
      contextLine(view, theme, barWidth),
      sessionLine(view, theme),
      savedLine(view, theme),
      keptOutLine(view, theme),
    ],
    bottom: [
      heading(theme, 'Per tier'),
      ...tierLines(view, theme, barWidth),
      heading(theme, 'Delegation'),
      ...treeLines(view, theme, width),
      learningLine(view, theme, width),
      ...(view.notes.length === 0
        ? []
        : [
            heading(theme, 'Recent'),
            ...view.notes.map((note): Line => [span(theme, `  ${fit(note, width - 2)}`, { isDim: true })]),
          ]),
    ],
  }
}
