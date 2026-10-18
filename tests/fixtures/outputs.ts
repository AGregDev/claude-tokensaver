/**
 * Realistic noisy tool outputs, built deterministically, for the trimmer's
 * efficiency benchmark (`npm run bench`) and its floors (tests/bench). Each
 * names the lines that must survive any trim: the ones a person would scroll
 * back for. Built in code rather than committed as logs, so they stay small,
 * readable and free of anyone's real paths or data.
 */

export type Fixture = {
  name: string
  text: string
  /** Lines that must appear, verbatim, in every trimmed form. */
  mustKeep: readonly string[]
}

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index)
const hex = (seed: number): string => ((seed * 2_654_435_761) >>> 0).toString(16).padStart(8, '0')

const npmInstall = (): Fixture => {
  const lines = [
    ...range(120).map(index => `npm WARN deprecated inflight@1.0.6: This module is not supported, and leaks memory.`.replace('inflight', index % 3 === 0 ? 'inflight' : index % 3 === 1 ? 'glob' : 'rimraf')),
    ...range(80).map(index => `\u001b[2K\u001b[1G\u001b[36m⠋\u001b[0m reify:fsevents: timing reifyNode:node_modules/pkg-${String(index)} Completed in ${String(index * 3)}ms\r`),
    'npm ERR! code ERESOLVE',
    'npm ERR! ERESOLVE unable to resolve dependency tree',
    '',
    'added 1342 packages, and audited 1343 packages in 41s',
    '',
    '212 packages are looking for funding',
    '  run `npm fund` for details',
  ]

  return { name: 'npm install', text: lines.join('\n'), mustKeep: ['npm ERR! code ERESOLVE', 'added 1342 packages, and audited 1343 packages in 41s'] }
}

const jest = (): Fixture => {
  const lines = [
    ...range(260).map(index => `\u001b[32m  ✓\u001b[39m renders widget ${String(index)} correctly (${String(3 + (index % 9))} ms)`),
    '\u001b[31m  ✕\u001b[39m saves the draft when offline (41 ms)',
    '',
    '  ● Editor › saves the draft when offline',
    '',
    '    expect(received).toBe(expected) // Object.is equality',
    '',
    '    Expected: "saved"',
    '    Received: "pending"',
    '',
    ...range(30).map(index => `      at Object.<anonymous> (src/editor/draft.test.ts:${String(40 + index)}:${String(5 + (index % 3))})`),
    '',
    'Test Suites: 1 failed, 37 passed, 38 total',
    'Tests:       1 failed, 260 passed, 261 total',
  ]

  return {
    name: 'jest run',
    text: lines.join('\n'),
    mustKeep: ['    Expected: "saved"', '    Received: "pending"', 'Tests:       1 failed, 260 passed, 261 total'],
  }
}

const cargo = (): Fixture => {
  const lines = [
    ...range(340).map(index => `   Compiling crate-${hex(index).slice(0, 5)} v0.${String(index % 17)}.${String(index % 5)}`),
    'error[E0308]: mismatched types',
    '  --> src/main.rs:42:13',
    '   |',
    '42 |     let x: u32 = "five";',
    '   |            ---   ^^^^^^ expected `u32`, found `&str`',
    '',
    'error: could not compile `app` (bin "app") due to 1 previous error',
  ]

  return {
    name: 'cargo build',
    text: lines.join('\n'),
    mustKeep: ['error[E0308]: mismatched types', 'error: could not compile `app` (bin "app") due to 1 previous error'],
  }
}

const dockerBuild = (): Fixture => {
  const lines = [
    ...range(25).flatMap(step => [
      `#${String(step + 4)} [${String(step + 1)}/25] RUN make target-${String(step)}`,
      ...range(12).map(frame => `#${String(step + 4)} ${String(frame)}.${String(step)}s downloading ${String(frame * 8)}%`),
      `#${String(step + 4)} DONE ${String(step * 0.4)}s`,
    ]),
    '#30 ERROR: process "/bin/sh -c make install" did not complete successfully: exit code: 2',
  ]

  return {
    name: 'docker build',
    text: lines.join('\n'),
    mustKeep: ['#30 ERROR: process "/bin/sh -c make install" did not complete successfully: exit code: 2'],
  }
}

const serverLog = (): Fixture => {
  const lines = range(2400).map(index =>
    index === 1777
      ? '2026-10-18T12:29:37.000Z ERROR db pool exhausted: timeout after 30000ms (active=50, idle=0)'
      : `2026-10-18T12:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z INFO GET /api/items/${String(index)} 200 ${String(4 + (index % 30))}ms req=${hex(index)}`,
  )

  return {
    name: 'server log (2.4k lines)',
    text: lines.join('\n'),
    mustKeep: ['2026-10-18T12:29:37.000Z ERROR db pool exhausted: timeout after 30000ms (active=50, idle=0)'],
  }
}

/** Clean, varied output that has nothing to trim: the trimmer must leave it alone. */
const gitDiffStat = (): Fixture => {
  const words = ['parser', 'lexer', 'router', 'cache', 'store', 'view', 'model', 'auth', 'billing', 'search']
  const lines = range(40).map(
    index => ` src/${words[index % words.length] ?? 'x'}/${words[(index * 7) % words.length] ?? 'y'}_${hex(index).slice(0, 3)}.ts | ${String(3 + index)} ${'+'.repeat(1 + (index % 6))}${'-'.repeat(index % 4)}`,
  )

  return { name: 'git diff --stat (clean)', text: lines.join('\n'), mustKeep: lines }
}

export const FIXTURES: readonly (() => Fixture)[] = [npmInstall, jest, cargo, dockerBuild, serverLog, gitDiffStat]

/** A big output for timing: about a megabyte of mixed noise. */
export const bigOutput = (): string => {
  const parts: string[] = []

  while (parts.join('\n').length < 1_000_000) {
    parts.push(...FIXTURES.slice(0, 5).map(make => make().text))
  }

  return parts.join('\n')
}
