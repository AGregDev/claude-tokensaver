/**
 * Tests that run inside Claude Code itself (`claude plugin test .`): the real
 * hooks module, loaded by the real engine, with the test standing in for
 * Claude Code beneath it. No session, sign-in or network is involved.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

const OPUS = 'claude-opus-5-5'
const SEARCH = 'find all usages of parseConfig across the repo and list every file'
const RISKY = 'find every place the production database password is read and delete the old one'

const SPAWN = {
  description: '',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: OPUS,
  background: false,
  fork: false,
} as const

const COMMAND = {
  command: 'tokensaver',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const PANE = {
  plugin: 'tokensaver',
  component: 'Pane',
  requestId: 'tokensaver',
  viewport: { columns: 100, rows: 30 },
  props: {
    title: 'tokensaver',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

type World = {
  /** The model each spawn reached Claude Code with; undefined means untouched. */
  models: (string | undefined)[]
  toasts: string[]
  logs: string[]
  statuses: (string | undefined)[]
  saved: Map<string, unknown>
  files: Map<string, string>
  clock: MockClock
}

/** Stands in for Claude Code beneath the mod, and records what reached it. */
const world = (on: On, env: Readonly<Record<string, string>> = {}): World => {
  const seen: World = {
    models: [],
    toasts: [],
    logs: [],
    statuses: [],
    saved: new Map(),
    files: new Map(),
    clock: mock.clock(on),
  }

  mock.env(on, env)
  on('store.get', (_$, e) => ({ value: seen.saved.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    seen.saved.delete(e.key)

    return { value: undefined }
  })
  on('fs.write', (_$, e) => {
    seen.files.set(e.path, e.text)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    seen.logs.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    seen.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('agent.spawn', (_$, e) => {
    seen.models.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: `agent-${String(seen.models.length)}` }
  })
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }))

  return seen
}

type Spawner = { agent: { spawn: (e: typeof SPAWN & { tool_use_id: string; prompt: string }) => Promise<unknown> } }

/**
 * tokensaver only observes the first spawn of an agent type. This plays that
 * spawn, in which the stub resolves the parent's model, and forgets it.
 */
const learn = async ($: Spawner, seen: World): Promise<void> => {
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'warm-up', prompt: 'hello there' })
  seen.models.length = 0
  seen.toasts.length = 0
}

test('observes the first spawn of an agent type, then routes that type', async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', prompt: SEARCH })

  expect(seen.models).toEqual([undefined, 'haiku'])
})

test('never reroutes an agent type that brings its own model', async ($, on) => {
  const models: (string | undefined)[] = []

  mock.clock(on)
  // This type always resolves to its own model, whatever the parent runs on.
  on('agent.spawn', (_$, e) => {
    models.push(e.model)

    return { model: e.model ?? 'claude-sonnet-5-5', agentId: `agent-${String(models.length)}` }
  })

  for (const id of ['call-1', 'call-2', 'call-3']) {
    await $.agent.spawn({ ...SPAWN, tool_use_id: id, prompt: SEARCH, subagentType: 'architect' })
  }

  expect(models).toEqual([undefined, undefined, undefined])
})

test('routes a mechanical sub-agent to haiku and says so', async ($, on) => {
  const seen = world(on)

  await learn($, seen)

  const started = await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })

  expect(seen.models).toEqual(['haiku'])
  expect(started.model).toBe('haiku')
  expect(seen.toasts.length).toBe(1)
  expect(seen.toasts[0]).toMatch(/→ haiku \(search\)/)
  expect(seen.statuses.at(-1)).toMatch(/tokensaver/)
})

test('never routes risky work to a cheaper model', async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: RISKY })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', prompt: RISKY, model: 'haiku' })

  // The first inherits the parent untouched; the second is raised from haiku to the parent.
  expect(seen.models).toEqual([undefined, OPUS])
})

test('leaves a fork alone', async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH, fork: true })

  expect(seen.models).toEqual([undefined])
  expect(seen.toasts).toEqual([])
})

test('dry-run shows what it would do and changes nothing', { options: { dryRun: true } }, async ($, on) => {
  const seen = world(on)

  await learn($, seen)

  const entered = await $.prompt.submit({ text: SEARCH, wait: false, origin: { kind: 'composer' } })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })

  expect(seen.models).toEqual([undefined])
  expect(entered.context).toBeUndefined()
  expect(seen.toasts.length).toBe(2)
  expect(seen.toasts[0]).toMatch(/dry-run: would suggest delegating/)
  expect(seen.toasts[1]).toMatch(/dry-run: would run .* on haiku/)
  expect(seen.saved.has('log')).toBe(false)
})

test('the master switch off passes everything through', { options: { enabled: false } }, async ($, on) => {
  const seen = world(on)

  const entered = await $.prompt.submit({ text: SEARCH, wait: false, origin: { kind: 'composer' } })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })

  expect(seen.models).toEqual([undefined])
  expect(entered.context).toBeUndefined()
  expect(seen.toasts).toEqual([])
})

test('/tokensaver off and on toggles routing, and answers outside the transcript', async ($, on) => {
  const seen = world(on)

  await learn($, seen)

  const off = await $.command.run({ ...COMMAND, args: 'off' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })
  await $.command.run({ ...COMMAND, args: 'on' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', prompt: SEARCH })

  expect(seen.models).toEqual([undefined, 'haiku'])
  // No `text`: nothing of the command's answer becomes a row the model reads.
  expect(off.text).toBeUndefined()
  expect(off.context).toBeUndefined()
  expect(seen.logs).toEqual(['tokensaver is off', 'tokensaver is on'])
  expect(seen.saved.get('settings')).toEqual({ isEnabled: true })
})

test('adds one short hint for a broad search and nothing for a small task', async ($, on) => {
  world(on)

  const broad = await $.prompt.submit({ text: SEARCH, wait: false, origin: { kind: 'composer' } })
  const small = await $.prompt.submit({
    text: 'fix the typo in README.md',
    wait: false,
    origin: { kind: 'composer' },
  })

  expect(broad.text).toBe(SEARCH)
  expect(broad.context?.length).toBe(1)
  expect(broad.context?.[0]).toMatch(/^\[tokensaver\] .*sub-agent/)
  expect(small.context).toBeUndefined()
})

test('retries a failed Agent call once, one tier up', async ($, on) => {
  const seen = world(on)
  let calls = 0

  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    calls += 1
    // Claude Code raises agent.spawn for the call, then the sub-agent's turn ends.
    const started = await $.agent.spawn({
      ...SPAWN,
      tool_use_id: e.tool_use_id,
      prompt: e.prompt,
      ...(e.model === undefined ? {} : { model: e.model }),
    })

    await $.turn.complete({
      turnId: `turn-${String(calls)}`,
      ...(started.agentId === undefined ? {} : { agentId: started.agentId }),
      answer: calls === 1 ? '' : 'Found 14 usages.',
      durationMs: 10,
      isAborted: false,
      reason: 'answer',
    })

    return calls === 1
      ? { isError: true, result: 'boom', text: 'The sub-agent crashed.' }
      : { result: 'Found 14 usages.', text: 'Found 14 usages.' }
  })

  await learn($, seen)

  const result = await $.tool.call({ tool: 'Agent', description: 'search usages', prompt: SEARCH })

  expect(calls).toBe(2)
  expect(seen.models).toEqual(['haiku', 'sonnet'])
  expect(result.text).toBe('Found 14 usages.')
  expect(seen.toasts.some(text => text.includes('failed on haiku (error), retrying on sonnet'))).toBe(true)
  expect(seen.saved.get('log')).toMatchObject([
    { taskType: 'search', tier: 'sonnet', retries: 1, wasEscalated: true, isSuccess: true },
  ])
})

test('returns a denied Agent call untouched and never retries it', async ($, on) => {
  const seen = world(on)
  let calls = 0

  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    calls += 1
    await $.agent.spawn({ ...SPAWN, tool_use_id: e.tool_use_id, prompt: e.prompt })

    return { deny: 'Denied by a permission rule.' }
  })

  await learn($, seen)

  const result = await $.tool.call({ tool: 'Agent', description: 'search usages', prompt: SEARCH })

  expect(calls).toBe(1)
  expect(result.deny).toBe('Denied by a permission rule.')
  expect(seen.models).toEqual(['haiku'])
  expect(seen.saved.has('log')).toBe(false)
})

test('leaves every other tool call alone', async ($, on) => {
  world(on)
  let calls = 0

  on('tool.call', () => {
    calls += 1

    return { isError: true, result: 'boom', text: 'failed' }
  })

  const result = await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(calls).toBe(1)
  expect(result.isError).toBe(true)
})

test('exports the log to a local file', async ($, on) => {
  const seen = world(on)

  await $.command.run({ ...COMMAND, args: 'export out.json' })

  expect([...seen.files.keys()].length).toBe(1)
  expect([...seen.files.keys()][0]).toMatch(/out\.json$/)
  expect([...seen.files.values()][0]).toMatch(/"format": "tokensaver-export"/)
})

test('the dashboard draws on the terminal and the desktop, and its buttons work', async ($, on) => {
  const seen = world(on)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH, description: 'search usages' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Text', text: 'tokensaver ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /search usages/ })).toBeDefined()
    expect((await ui.find({ key: 'power' }))?.props['label']).toBe('Turn off')
    // Colour is on by default.
    expect((await ui.find({ type: 'Text', text: '● on' }))?.props['color']).toBe('success')

    await ui.press({ key: 'dry-run' })
    expect((await ui.find({ key: 'dry-run' }))?.props['label']).toBe('Leave dry-run')
    expect(await ui.find({ type: 'Text', text: '◌ dry-run' })).toBeDefined()
    await ui.press({ key: 'dry-run' })
    await ui.unmount()
  }

  expect(seen.logs).toEqual([
    'tokensaver dry-run is on',
    'tokensaver dry-run is off',
    'tokensaver dry-run is on',
    'tokensaver dry-run is off',
  ])
})

test('the desktop draws the savings trend as a vector once there is a history', async ($, on) => {
  world(on)

  for (const turnId of ['t1', 't2']) {
    await $.turn.complete({ turnId, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
  }

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await desktop.find({ type: 'Svg' }))?.props['alt']).toMatch(/last 2 turns/)
  expect(await terminal.find({ type: 'Svg' })).toBeUndefined()
  expect(await terminal.find({ type: 'Text', text: /^[▁-█]+$/u })).toBeDefined()
})

test('NO_COLOR removes every colour from the dashboard', async ($, on) => {
  world(on, { NO_COLOR: '1' })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const mode = await ui.find({ type: 'Text', text: '● on' })

  expect(mode).toBeDefined()
  expect(mode?.props['color']).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /haiku/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /haiku/ }))?.props['color']).toBeUndefined()
})

test('reduced motion stops the animation clock', { options: { reducedMotion: true } }, async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })

  // A running agent draws a fixed glyph, not a spinner frame.
  expect(seen.statuses.at(-1)).toMatch(/^◆ tokensaver/u)
})

test('keeps working when the store and the environment are unavailable', async ($, on) => {
  const models: (string | undefined)[] = []

  // No store, env, clock or UI beneath the mod: every such call fails.
  on('agent.spawn', (_$, e) => {
    models.push(e.model)

    return { model: e.model ?? e.parentModel, agentId: 'agent-1' }
  })
  on('session.start', () => ({ cwd: '/work' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH })
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-2', prompt: SEARCH })

  expect(models).toEqual([undefined, 'haiku'])
})

test('never changes a permission decision', async ($, on) => {
  world(on)

  const decisions = ['deny', 'ask', 'allow'] as const
  let asked = 0

  on('tool.check', () => {
    asked += 1

    return { decision: decisions[asked - 1] ?? 'deny' }
  })

  // Whatever the rules decide beneath the mod is what comes back above it.
  for (const decision of decisions) {
    const verdict = await $.tool.check({ tool: 'Agent', input: { prompt: SEARCH } })

    expect(verdict.decision).toBe(decision)
  }
})

test('meters each model request without touching the response', async ($, on) => {
  const seen = world(on)

  // The kit takes a turn.step stub as an async generator, awaits or not.
  // eslint-disable-next-line @typescript-eslint/require-await
  on('turn.step', async function* (_$, e) {
    yield { kind: 'text', index: 0, text: 'ok' }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: OPUS,
        input_tokens: 1200,
        output_tokens: 300,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 500,
      },
    }
  })

  const stream = $.turn.step({ turnId: 't1', index: 0, model: OPUS, messageCount: 1 })
  const chunks: string[] = []
  let step = await stream.next()

  while (step.done !== true) {
    chunks.push(step.value.kind)
    step = await stream.next()
  }

  expect(chunks).toEqual(['text'])
  expect(step.value.answer).toBe('ok')
  // New work only: input + output + cache writes. Cache reads are not counted.
  expect(seen.statuses.at(-1)).toMatch(/tokensaver 2\.0k tok .* O 2\.0k/)
})

test('animates the spinner only while a sub-agent is running', async ($, on) => {
  const seen = world(on)

  await $.agent.spawn({ ...SPAWN, tool_use_id: 'call-1', prompt: SEARCH, background: true })

  const before = seen.statuses.at(-1) ?? ''

  await seen.clock.advance(250)

  const during = seen.statuses.at(-1) ?? ''

  expect(before.slice(0, 1)).not.toBe(during.slice(0, 1))
  expect(before.slice(1)).toBe(during.slice(1))

  await $.turn.complete({
    turnId: 't1',
    agentId: 'agent-1',
    answer: 'Found 14 usages.',
    durationMs: 10,
    isAborted: false,
    reason: 'answer',
  })
  // Let the saved counter finish easing, after which the timer cancels itself.
  await seen.clock.advance(20_000)

  const settled = seen.statuses.length

  await seen.clock.advance(5000)

  expect(seen.statuses.length).toBe(settled)
  expect(seen.statuses.at(-1)).toMatch(/^● tokensaver/u)
})
