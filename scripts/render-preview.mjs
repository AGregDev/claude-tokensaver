// Renders the README's pictures: docs/dashboard.svg, docs/statusline.svg and docs/strip.svg.
//
// They are not screenshots. They are the real renderers in src/ui, run over a
// sample session that is itself produced by playing events through the real
// controller, and then painted as SVG instead of by Claude Code. The text and
// its styling are exactly what the mod draws; the window around it is not.
//
// Needs Node 22.18+ (it imports the TypeScript sources directly).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  hydrate,
  onAgentResult,
  onMeasure,
  onPrompt,
  onSpawn,
  onSpawned,
  onStepUsage,
  onTurnComplete,
} from '../src/runtime/session.ts'
import { bandSvg } from '../src/ui/band.ts'
import { renderDashboard, sparklineLine } from '../src/ui/dashboard.ts'
import { renderStatusLine } from '../src/ui/statusline.ts'
import { toView } from '../src/ui/view.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OPUS = 'claude-opus-5-5'

// --- A sample session, played through the controller ------------------------

const storedLog = Array.from({ length: 41 }, (_, index) => ({
  seq: index + 1,
  at: 1,
  taskType: index % 3 === 0 ? 'bulk-read' : 'search',
  tier: index % 5 === 0 ? 'sonnet' : 'haiku',
  tokens: 3000,
  retries: index === 17 ? 1 : 0,
  wasEscalated: index === 17,
  isSuccess: true,
  signal: 'ok',
}))

let session = hydrate({
  options: {},
  storedLog,
  storedThresholds: undefined,
  storedSettings: undefined,
  noColor: undefined,
}).session
let agents = 0

const apply = step => {
  session = step.session

  return step.reply
}

const mainTurn = (turnId, tokens) => {
  apply(
    onStepUsage(session, {
      turnId,
      agentId: undefined,
      usage: { model: OPUS, input: tokens, output: 900, cacheWrite: 0 },
    }),
  )
  apply(
    onTurnComplete(session, {
      turnId,
      agentId: undefined,
      usage: undefined,
      isFailed: false,
      isAborted: false,
      answer: 'done',
      now: 1,
    }),
  )
}

/** One Agent call; `results` are the first attempt's answer and, if it fails, the retry's. */
const agent = ({ toolUseId, prompt, description, tokens, results, parentAgentId, isLeftRunning }) => {
  let explicitModel

  for (const text of results) {
    agents += 1

    const agentId = `agent-${agents}`
    const spawn = apply(
      onSpawn(session, {
        toolUseId,
        prompt,
        description,
        subagentType: 'general-purpose',
        explicitModel,
        parentModel: OPUS,
        parentAgentId,
        isBackground: false,
        isPinned: false,
      }),
    )
    const model = spawn.model ?? explicitModel ?? OPUS

    apply(onSpawned(session, { toolUseId, agentId, isDenied: false, resolvedModel: model }))
    apply(
      onStepUsage(session, {
        turnId: `t-${agentId}`,
        agentId,
        usage: { model, input: tokens, output: 300, cacheWrite: 0 },
      }),
    )

    if (isLeftRunning) {
      return agentId
    }

    apply(
      onTurnComplete(session, {
        turnId: `t-${agentId}`,
        agentId,
        usage: undefined,
        isFailed: false,
        isAborted: false,
        answer: text,
        now: 1,
      }),
    )

    const reply = apply(
      onAgentResult(session, {
        toolUseId,
        isDenied: false,
        isError: false,
        text,
        totalTokens: undefined,
        now: 1,
      }),
    )

    if (reply.retryWith === undefined) {
      return agentId
    }

    explicitModel = reply.retryWith
  }

  return undefined
}

apply(onPrompt(session, { text: 'find all usages of parseConfig across the repo and list every file', isFromUser: true, now: 1 }))
agent({
  toolUseId: 'call-1',
  prompt: 'find all usages of parseConfig across the repo and list every file',
  description: 'find parseConfig usages',
  tokens: 9400,
  results: ['Found 14 usages in 6 files.'],
})
mainTurn('turn-1', 6200)

apply(onPrompt(session, { text: 'rename getUser to fetchUser in every file across the repo', isFromUser: true, now: 1 }))
agent({
  toolUseId: 'call-2',
  prompt: 'rename getUser to fetchUser in every file across the repo',
  description: 'rename getUser everywhere',
  tokens: 5200,
  results: ['Renamed 9 files, but 2 tests failed.', 'Renamed 11 files. All tests pass.'],
})
mainTurn('turn-2', 7100)

apply(onPrompt(session, { text: 'read through every file in docs/ and summarize the open questions', isFromUser: true, now: 1 }))
agent({
  toolUseId: 'call-3',
  prompt: 'read through every file in docs/ and gather every open question',
  description: 'survey docs for open questions',
  tokens: 12800,
  results: ['Read 23 files. 7 open questions.'],
})
mainTurn('turn-3', 5400)

apply(onPrompt(session, { text: 'summarize the build logs across all packages and give me a recap of every warning', isFromUser: true, now: 1 }))

const parent = agent({
  toolUseId: 'call-4',
  prompt: 'summarize the build logs across all packages and give me a recap of every warning',
  description: 'summarize build logs',
  tokens: 2100,
  results: [''],
  isLeftRunning: true,
})

agent({
  toolUseId: 'call-5',
  prompt: 'find all warnings in packages/api/build.log and list every one',
  description: 'scan packages/api log',
  tokens: 800,
  results: [''],
  parentAgentId: parent,
  isLeftRunning: true,
})
apply(onStepUsage(session, { turnId: 'turn-4', agentId: undefined, usage: { model: OPUS, input: 4300, output: 400, cacheWrite: 0 } }))
apply(onMeasure(session, { tokens: 48_200, window: 200_000 }))
session = { ...session, shownSaved: session.saved, frame: 1 }

// --- Painting ---------------------------------------------------------------

const CELL = 8.6
const LINE = 20
const PAD = 18
const FONT = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"
const INK = '#e6e6e6'
const TONES = {
  success: '#4eba65',
  warning: '#ffc107',
  error: '#ff6b80',
  claude: '#d77757',
  suggestion: '#b1b9f9',
  inactive: '#999999',
}

const escapeXml = text =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** SVG collapses runs of spaces; a no-break space keeps every cell of the grid. */
const cells = text => escapeXml(text).replace(/ /g, ' ')

/** One styled line as SVG text, every span pinned to its column so the grid holds in any font. */
const paintLine = (line, y, extra = '') => {
  let column = 0

  return line
    .map(part => {
      const x = PAD + column * CELL
      const width = part.text.length * CELL

      column += part.text.length

      if (part.text.trim() === '') {
        return ''
      }

      const attributes = [
        `x="${x.toFixed(1)}"`,
        `y="${y}"`,
        `textLength="${width.toFixed(1)}"`,
        'lengthAdjust="spacingAndGlyphs"',
        `fill="${part.tone === undefined ? INK : TONES[part.tone]}"`,
        part.isBold === true ? 'font-weight="700"' : '',
        part.isDim === true ? 'opacity="0.55"' : '',
        extra,
      ]
        .filter(attribute => attribute !== '')
        .join(' ')

      return `<text ${attributes}>${cells(part.text)}</text>`
    })
    .join('')
}

const frameSvg = ({ width, height, title, body, caption }) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    `<rect width="${width}" height="${height}" rx="10" fill="#1b1b1f"/>`,
    `<rect width="${width}" height="30" rx="10" fill="#2a2a30"/><rect y="20" width="${width}" height="10" fill="#2a2a30"/>`,
    '<circle cx="18" cy="15" r="5" fill="#ff5f57"/><circle cx="36" cy="15" r="5" fill="#febc2e"/><circle cx="54" cy="15" r="5" fill="#28c840"/>',
    `<text x="${width / 2}" y="19" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#9a9aa2">${escapeXml(title)}</text>`,
    `<g font-family="${FONT}" font-size="14" xml:space="preserve">${body}</g>`,
    `<text x="${width - 12}" y="${height - 9}" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#6c6c75">${escapeXml(caption)}</text>`,
    '</svg>',
    '',
  ].join('\n')

const CAPTION = 'Rendered by src/ui from sample data, not a screenshot'
const COLUMNS = 64

// The dashboard pane.
const view = toView(session)
const dashboard = renderDashboard(view, COLUMNS)
const lines = [...dashboard.top, sparklineLine(view, COLUMNS), ...dashboard.bottom]
const buttons = [
  { text: '[ Turn off ]', isBold: true },
  { text: '  ' },
  { text: '[ Dry-run ]' },
]
const rows = [...lines, [], buttons]
const paneWidth = Math.ceil(PAD * 2 + COLUMNS * CELL)
const paneHeight = 30 + PAD + rows.length * LINE + 22

mkdirSync(join(root, 'docs'), { recursive: true })
writeFileSync(
  join(root, 'docs', 'dashboard.svg'),
  frameSvg({
    width: paneWidth,
    height: paneHeight,
    title: 'tokensaver dashboard pane',
    body: rows.map((line, index) => paintLine(line, 30 + PAD + 14 + index * LINE)).join('\n'),
    caption: CAPTION,
  }),
)

// The CLI status line, animated: the four spinner frames, then the same line under reduced motion.
const FRAME_SECONDS = 0.25
const frames = [0, 1, 2, 3].map(frame => renderStatusLine({ ...view, frame }) ?? '')
const longest = Math.max(...frames.map(text => text.length))
const statusWidth = Math.ceil(PAD * 2 + Math.max(longest, 72) * CELL)
const total = FRAME_SECONDS * frames.length
const animated = frames
  .map((text, index) => {
    const from = (index * FRAME_SECONDS) / total
    const to = ((index + 1) * FRAME_SECONDS) / total
    const values = index === 0 ? '1;0;0' : '0;1;0;0'
    const keyTimes = index === 0 ? `0;${to};1` : `0;${from};${to};1`
    const animate = `<animate attributeName="opacity" calcMode="discrete" dur="${total}s" repeatCount="indefinite" values="${values}" keyTimes="${keyTimes}"/>`

    // Only the spinner glyph differs between frames, so only it is animated.
    return `<text x="${PAD}" y="${30 + PAD + 14 + LINE}" fill="${TONES.claude}" opacity="${index === 0 ? 1 : 0}">${escapeXml(text.slice(0, 1))}${animate}</text>`
  })
  .join('\n')
const rest = paintLine([{ text: ' ' }, { text: frames[0].slice(1) }], 30 + PAD + 14 + LINE)
const still = renderStatusLine({ ...view, hasReducedMotion: true }) ?? ''
const statusBody = [
  paintLine([{ text: '> ', isDim: true }, { text: 'summarize the build logs across all packages', isDim: true }], 30 + PAD + 14),
  animated,
  rest,
  paintLine([{ text: 'with reduced motion:', isDim: true }], 30 + PAD + 14 + LINE * 3),
  paintLine([{ text: still }], 30 + PAD + 14 + LINE * 4),
].join('\n')

writeFileSync(
  join(root, 'docs', 'statusline.svg'),
  frameSvg({
    width: statusWidth,
    height: 30 + PAD + LINE * 5 + 26,
    title: 'tokensaver status line (CLI)',
    body: statusBody,
    caption: CAPTION,
  }),
)

// The strip above the prompt, exactly as the desktop app is handed it: an animated picture
// that follows light and dark by itself, so it needs no window drawn around it.
writeFileSync(join(root, 'docs', 'strip.svg'), `${bandSvg(view, 720)}
`)

console.log('preview: docs/dashboard.svg, docs/statusline.svg, docs/strip.svg')
console.log(lines.map(line => line.map(part => part.text).join('')).join('\n'))
console.log(frames[0])
