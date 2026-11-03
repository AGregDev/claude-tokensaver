/**
 * The caveman voice inside Claude Code itself (`claude plugin test .`): the
 * real hooks module under the real engine, the test standing in beneath it.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const OPUS = 'claude-opus-5-5'

const COMMAND = {
  command: 'tokensaver',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const SPAWN = {
  description: '',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: OPUS,
  background: false,
  fork: false,
} as const

/** What a system prompt is composed for, as the engine resolves it. */
const FACTS = { model: OPUS, promptModel: OPUS, surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

const ROW: SessionMessage = { role: 'user', text: 'fix the auth bug', toolUses: [] }

type World = { prompts: string[]; compacts: (string | undefined)[]; saved: Map<string, unknown>; statuses: (string | undefined)[] }

const world = (on: On): World => {
  const seen: World = { prompts: [], compacts: [], saved: new Map(), statuses: [] }

  mock.clock(on)
  mock.env(on, {})
  on('store.get', (_$, e) => ({ value: seen.saved.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.model', () => ({ value: OPUS }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: [] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))
  on('ui.render', (_$, e) => ({ type: 'Text', props: {}, children: [`engine ${e.component}`] }))
  // Claude Code's own system prompt, as a stand-in: one shared section and one session section.
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code.', scope: 'shared' },
      { id: 'memory', text: 'No memory.', scope: 'session' },
    ],
  }))
  on('agent.spawn', (_$, e) => {
    seen.prompts.push(e.prompt)

    return { model: e.model ?? e.parentModel, agentId: `agent-${String(seen.prompts.length)}` }
  })
  on('session.compact', (_$, e) => {
    seen.compacts.push(e.instructions)

    const summary: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }

    return { messages: [summary], tokensBefore: 150_000, tokensAfter: 12_000 }
  })

  return seen
}

const voiceSection = async ($: Engine): Promise<string | undefined> => {
  const composed = await $.prompt.compose(FACTS)

  return composed.sections.find(section => section.id === 'tokensaver:caveman')?.text
}

const finish = ($: Engine, turnId: string, output: number) =>
  $.turn.complete({
    turnId,
    answer: 'done',
    durationMs: 5,
    isAborted: false,
    reason: 'answer',
    usage: {
      model: OPUS,
      input_tokens: 10,
      output_tokens: output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })

test('adds the caveman voice to the system prompt, last and after the cache boundary', async ($, on) => {
  world(on)

  const composed = await $.prompt.compose(FACTS)
  const last = composed.sections[composed.sections.length - 1]

  expect(composed.sections.map(section => section.id)).toEqual(['intro', 'memory', 'tokensaver:caveman'])
  expect(last?.scope).toBe('session')
  expect(last?.text).toMatch(/Respond terse like smart caveman/)
})

test('/tokensaver caveman switches the voice, is remembered, and off leaves the prompt as it was', async ($, on) => {
  const seen = world(on)

  const ultra = await $.command.run({ ...COMMAND, args: 'caveman ultra' })

  expect(ultra.text).toMatch(/ultra/)
  expect(await voiceSection($)).toMatch(/grammar stripped/)

  const off = await $.command.run({ ...COMMAND, args: 'caveman off' })

  expect(off.text).toMatch(/normal voice/)
  expect(seen.saved.get('assistant')).toEqual({ voice: 'off' })
  expect((await $.prompt.compose(FACTS)).sections.map(section => section.id)).toEqual(['intro', 'memory'])

  const wrong = await $.command.run({ ...COMMAND, args: 'caveman loud' })

  expect(wrong.text).toMatch(/on, ultra or off/)
})

test('the option turns the voice off, and the master switch takes it out too', { options: { caveman: 'off' } }, async ($, on) => {
  world(on)

  expect(await voiceSection($)).toBeUndefined()

  await $.command.run({ ...COMMAND, args: 'caveman on' })
  expect(await voiceSection($)).toBeDefined()

  await $.command.run({ ...COMMAND, args: 'off' })
  expect(await voiceSection($)).toBeUndefined()
})

test('"stop caveman" typed as a prompt switches the voice and still reaches Claude', async ($, on) => {
  const seen = world(on)

  const entered = await $.prompt.submit({ text: 'stop caveman', wait: false, origin: { kind: 'composer' } })

  expect(entered.text).toBe('stop caveman')
  expect(entered.context?.some(line => line.includes('switched the caveman voice off'))).toBe(true)
  expect(await voiceSection($)).toBeUndefined()
  expect(seen.saved.get('assistant')).toEqual({ voice: 'off' })

  // A task that only mentions the phrase is a task.
  await $.prompt.submit({ text: 'caveman mode', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: 'put vim back in normal mode after the edit', wait: false, origin: { kind: 'composer' } })
  expect(await voiceSection($)).toBeDefined()
})

test('asks a sub-agent for a terse report, and leaves a fork and a workflow agent alone', async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: 'list every caller of parseConfig' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', prompt: 'carry on', fork: true, subagentType: 'fork' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-3', prompt: 'step', workflow: { runId: 'wf_1', agentIndex: 1 } })

  expect(seen.prompts[0]).toMatch(/^list every caller of parseConfig\n\n\(tokensaver: report terse\)/)
  expect(seen.prompts[1]).toBe('carry on')
  expect(seen.prompts[2]).toBe('step')
})

test('asks for a terse summary when the conversation compacts, whoever started it', async ($, on) => {
  const seen = world(on)

  await $.session.compact({ trigger: 'manual', instructions: 'focus on the auth bug', messages: [ROW] })
  await $.session.compact({ trigger: 'auto', messages: [ROW] })
  await $.session.compact({ trigger: 'auto', agentId: 'agent-9', messages: [ROW] })

  expect(seen.compacts[0]).toMatch(/^focus on the auth bug .*caveman style/)
  expect(seen.compacts[1]).toMatch(/caveman style/)
  expect(seen.compacts[2]).toBeUndefined()
})

test('measures replies by voice and reports the comparison once both have enough', async ($, on) => {
  const seen = world(on)

  for (const turn of [1, 2, 3, 4, 5]) {
    await finish($, `terse-${String(turn)}`, 200)
  }

  await $.command.run({ ...COMMAND, args: 'caveman off' })

  for (const turn of [1, 2, 3, 4, 5]) {
    await finish($, `plain-${String(turn)}`, 500)
  }

  const status = await $.command.run({ ...COMMAND, args: '' })

  expect(status.text).toMatch(/replies average 200 output tokens with it, 500 without \(60% fewer, over 10 replies\)/)
  expect(seen.saved.get('lifetime')).toMatchObject({ voice: { terse: { turns: 5, output: 1000 }, plain: { turns: 5, output: 2500 } } })
  expect(seen.statuses.some(line => line?.includes('caveman') === true)).toBe(true)
})
