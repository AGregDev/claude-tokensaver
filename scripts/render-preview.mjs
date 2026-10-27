// Renders the README's pictures into docs/: Clawd's pane, its moods, the band
// above the prompt, and the sub-agent strip.
//
// They are not screenshots. They are the mod's real renderers in src/ui, run
// over sample figures (and, for the strip, over a session played through the
// real controller), written out exactly as the desktop app receives them. The
// animation is CSS inside each picture, so it plays on GitHub too.
//
// Needs Node 22.18+ (it imports the TypeScript sources directly).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hydrate, onSpawn, onSpawned } from '../src/runtime/session.ts'
import { bandSvg } from '../src/ui/band.ts'
import { bandSvgOf, clawdBody, heroSvg, tilesSvg } from '../src/ui/clawd.ts'
import { toView } from '../src/ui/view.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docs = join(root, 'docs')
const OPUS = 'claude-opus-5-5'
const WIDTH = 640

/** Sample figures from a long session: what the pane looks like after an afternoon's work. */
const view = overrides => ({
  mood: 'idle',
  speech: '31.2k tokens eaten so far, ~412.0k re-sends avoided.',
  mode: 'on',
  hasMotion: true,
  hasColor: true,
  isQuiet: false,
  context: { tokens: 84_000, window: 200_000, percent: 42 },
  ghost: 23_000,
  stats: { eaten: 31_200, reReads: 412_000, compactFreed: 138_000, routed: 9100, keptOut: 4000, trims: 17, compactions: 1 },
  feed: [],
  activeAgents: 0,
  frame: 0,
  ...overrides,
})

/** Stacks pictures into one, each as a nested <svg> so its own styles and ids stay its own. */
const stack = (title, parts, gap = 14) => {
  let y = 0
  const placed = parts.map(svg => {
    const height = Number(/height="(\d+(?:\.\d+)?)"/.exec(svg)?.[1] ?? 0)
    const nested = svg.replace('<svg ', `<svg y="${String(y)}" `)

    y += height + gap

    return nested
  })
  const height = y - gap

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(height)}" viewBox="0 0 ${String(WIDTH)} ${String(height)}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    ...placed,
    '</svg>',
    '',
  ].join('\n')
}

const MOODS = [
  ['idle', 'idle'],
  ['chomp', 'eating noise'],
  ['happy', 'compacted'],
  ['busy', 'helpers running'],
  ['worried', 'context 74%'],
  ['sleepy', 'cache cold'],
  ['alert', 'escalated'],
]

/** Every mood side by side, each Clawd animating in its own way. */
const moodsSvg = () => {
  const p = 5
  const cell = WIDTH / MOODS.length
  const height = 110
  const sample = heroSvg(view({}), WIDTH)
  const style = /<style>[\s\S]*?<\/style>/.exec(sample)?.[0] ?? ''

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(WIDTH)}" height="${String(height)}" viewBox="0 0 ${String(WIDTH)} ${String(height)}" role="img" aria-label="Clawd's moods">`,
    "<title>Clawd's moods</title>",
    style,
    ...MOODS.map(([mood, label], index) => {
      const x = index * cell + (cell - 14 * p) / 2

      return [
        `<g class="c ${mood}" transform="translate(${x.toFixed(1)} 26)">${clawdBody(mood, p)}</g>`,
        `<text class="d" x="${(index * cell + cell / 2).toFixed(1)}" y="${String(height - 6)}" font-size="12" text-anchor="middle">${label}</text>`,
      ].join('')
    }),
    '</svg>',
    '',
  ].join('\n')
}

/** Two helpers running on haiku, played through the real controller, for the sub-agent strip. */
const stripView = () => {
  let session = hydrate({ options: {}, storedLog: undefined, storedThresholds: undefined, storedSettings: undefined, noColor: undefined }).session

  for (const [index, description] of ['find usages of parseConfig', 'read the migration guides'].entries()) {
    const toolUseId = `call-${String(index)}`

    // The first spawn of a type is watched, not routed: it shows the type inherits its model.
    session = onSpawned(
      onSpawn(session, { toolUseId: `probe-${String(index)}`, prompt: 'hello', description: '', subagentType: 'Explore', explicitModel: undefined, parentModel: OPUS, parentAgentId: undefined, isBackground: true, isPinned: false }).session,
      { toolUseId: `probe-${String(index)}`, agentId: `probe-${String(index)}`, isDenied: false, resolvedModel: OPUS },
    ).session
    session = onSpawn(session, {
      toolUseId,
      prompt: `${description} across the repo and list every file`,
      description,
      subagentType: 'Explore',
      explicitModel: undefined,
      parentModel: OPUS,
      parentAgentId: undefined,
      isBackground: false,
      isPinned: false,
    }).session
    session = onSpawned(session, { toolUseId, agentId: `agent-${String(index)}`, isDenied: false, resolvedModel: 'haiku' }).session
  }

  return toView({ ...session, agents: session.agents.filter(agent => !agent.key.startsWith('probe-')) })
}

mkdirSync(docs, { recursive: true })

for (const old of ['dashboard.svg', 'statusline.svg']) {
  rmSync(join(docs, old), { force: true })
}

writeFileSync(join(docs, 'clawd-pane.svg'), stack("Clawd's pane: the mascot, the context meter and the savings", [heroSvg(view({}), WIDTH), tilesSvg(view({}), WIDTH)]))
writeFileSync(join(docs, 'clawd-moods.svg'), moodsSvg())
writeFileSync(
  join(docs, 'clawd-band.svg'),
  stack('The band above the prompt', [
    bandSvgOf(view({ mood: 'chomp', speech: 'Ate 3.4k tokens of Bash noise: colour codes, repeated lines and look-alike lines' }), WIDTH),
    bandSvgOf(view({ mood: 'sleepy', speech: "Zzz… cache went cold. Next message re-writes ~105k tokens; compact first and it's ~10.5k." }), WIDTH),
  ], 6),
)
writeFileSync(join(docs, 'strip.svg'), `${bandSvg(stripView(), WIDTH)}\n`)

console.log('preview: docs/clawd-pane.svg, docs/clawd-moods.svg, docs/clawd-band.svg, docs/strip.svg')
