/**
 * Clawd's savers inside Claude Code itself (`claude plugin test .`): the real
 * hooks module under the real engine, the test standing in beneath it.
 */
import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'

const NOISY = Array.from({ length: 400 }, (_, index) =>
  index % 50 === 0 ? `\u001b[33mwarn\u001b[0m step ${String(index)}` : 'npm WARN deprecated left-pad@1.0.0',
).join('\n')

type World = { toasts: string[]; compacts: (string | undefined)[]; clock: MockClock; saved: Map<string, unknown> }

const world = (on: On): World => {
  const seen: World = { toasts: [], compacts: [], clock: mock.clock(on), saved: new Map() }

  mock.env(on, {})
  on('store.get', (_$, e) => ({ value: seen.saved.get(e.key) }))
  on('store.set', (_$, e) => {
    seen.saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.surfaces', () => ({ value: ['terminal'] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: [] }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  // Newer builds store the row beneath the test; older ones have no such bottom, so the stand-in keeps it.
  on('session.append', async (_$, e, next) => {
    try {
      return await next(e)
    } catch {
      return { message: e.message, uuid: e.uuid }
    }
  })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('session.compact', (_$, e) => {
    seen.compacts.push(e.instructions ?? `(no instructions: ${JSON.stringify(Object.keys(e))})`)

    const summary: SessionMessage = { role: 'user', text: 'summary', toolUses: [] }

    return { messages: [summary], tokensBefore: 150_000, tokensAfter: 12_000 }
  })
  on('ui.render', (_$, e) => ({ type: 'Text', props: {}, children: [`engine ${e.component}`] }))

  return seen
}

const toolResult = ($: Engine, tool: string, text: string, id = 'tool-1') =>
  $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool },
    uuid: `row-${id}`,
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text }],
    },
  })

const stored = (result: Awaited<ReturnType<typeof toolResult>>): string => {
  const block = result.message?.content[0]

  return typeof block?.['content'] === 'string' ? block['content'] : JSON.stringify(block?.['content'])
}

const measure = ($: Engine, tokens: number) =>
  $.session.measure({ context: { tokens, window: 200_000 }, rateLimits: [], changed: ['context'] })

test('trims noisy shell output before it is stored, and marks its row', async ($, on) => {
  world(on)

  const result = await toolResult($, 'Bash', NOISY)
  const text = stored(result)

  expect(text.length).toBeLessThan(NOISY.length / 4)
  expect(text).not.toContain('\u001b')
  expect(text).toContain('warn step 50')

  const row = await $.ui.mount({
    plugin: 'tokensaver',
    component: 'ToolUse',
    surface: 'terminal',
    props: { tool_use_id: 'tool-1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false },
  })

  expect(await row.find({ type: 'Text', text: /Clawd ate .* tokens of noise/ })).toBeDefined()
})

test('leaves file reads and errors exactly as they came', async ($, on) => {
  world(on)

  expect(stored(await toolResult($, 'Read', NOISY))).toBe(NOISY)
  expect(stored(await toolResult($, 'Glob', NOISY))).toBe(NOISY)
})

test('trim off stores output untouched', { options: { trimOutput: false } }, async ($, on) => {
  world(on)

  expect(stored(await toolResult($, 'Bash', NOISY))).toBe(NOISY)
})

test('/tokensaver trim off is remembered', async ($, on) => {
  const seen = world(on)

  const reply = await $.command.run({
    command: 'tokensaver',
    args: 'trim off',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(reply.text).toBe('Clawd: output trimming is off')
  expect(seen.saved.get('assistant')).toEqual({ isTrimming: false })
  expect(stored(await toolResult($, 'Bash', NOISY))).toBe(NOISY)
})

test('tidies a pasted log in a prompt, losslessly, and says so', async ($, on) => {
  const seen = world(on)
  const pasted = `why does the install fail?\n${NOISY}`

  const entered = await $.prompt.submit({ text: pasted, wait: false, origin: { kind: 'composer' } })

  expect((entered.text ?? '').startsWith('why does the install fail?')).toBe(true)
  expect((entered.text ?? '').length).toBeLessThan(pasted.length / 4)
  expect(seen.toasts.some(toast => toast.startsWith('Clawd: Tidied your pasted log'))).toBe(true)
})

test('warns as the context fills, and the band offers to compact', async ($, on) => {
  const seen = world(on)

  await measure($, 150_000)

  expect(seen.toasts.some(toast => toast.includes('Context at 75%'))).toBe(true)

  const band = await $.ui.mount({
    plugin: 'tokensaver',
    component: 'AbovePrompt',
    surface: 'terminal',
    viewport: { columns: 100, rows: 30 },
    props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4 }, view: {} },
  })

  expect((await band.find({ key: 'band-compact' }))?.props['label']).toBe('Compact now')

  await band.press({ key: 'band-compact' })
  await seen.clock.advance(100)

  expect(seen.compacts).toHaveLength(1)
  expect(seen.compacts[0]).toMatch(/Keep: the current goal/)
})

test('/tokensaver compact keeps the recent asks in focus and books what it freed', async ($, on) => {
  const seen = world(on)

  await $.prompt.submit({ text: 'migrate the billing service to the new queue', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })

  const reply = await $.command.run({
    command: 'tokensaver',
    args: 'compact',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(reply.text).toMatch(/compacting/)
  await seen.clock.advance(100)
  expect(seen.compacts[0]).toMatch(/migrate the billing service/)

  const status = await $.command.run({
    command: 'tokensaver',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(status.text).toMatch(/138\.0k freed by 1 compaction/)
})

test('never compacts by itself unless opted in', async ($, on) => {
  const seen = world(on)

  await measure($, 190_000)

  expect(seen.compacts).toEqual([])
})

test('auto-compacts between turns once opted in', { options: { autoCompactAt: 80 } }, async ($, on) => {
  const seen = world(on)

  await measure($, 170_000)
  await seen.clock.advance(10)

  expect(seen.compacts).toHaveLength(1)
})

test('says when the prompt cache has gone cold', async ($, on) => {
  const seen = world(on)

  await measure($, 90_000)
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
  await seen.clock.advance(6 * 60_000)

  expect(seen.toasts.some(toast => toast.includes('cache went cold'))).toBe(true)
})

test('never folds what a search printed, and folds the same lines from a build', async ($, on) => {
  world(on)

  const matches = Array.from({ length: 60 }, (_, index) => `src/config.ts:${String(index + 1)}: const value${String(index)} = parseConfig(input)`).join('\n')
  const call = (id: string, command: string) =>
    $.session.append({
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' },
      uuid: `call-${id}`,
      message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    })

  await call('search', 'grep -n parseConfig src/config.ts')
  expect(stored(await toolResult($, 'Bash', matches, 'search'))).toBe(matches)

  await call('build', 'npm run build')
  expect(stored(await toolResult($, 'Bash', matches, 'build'))).toContain('more lines like these')
})
