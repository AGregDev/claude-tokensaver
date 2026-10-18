// Prints how much the trimmer saves on realistic noisy outputs, and how fast.
//
// The fixtures live in tests/fixtures/outputs.ts; the floors this report is
// held to live in tests/bench/trim.spec.ts and run with every `npm test`.
// Run this after changing src/core/trim.ts to see the effect at a glance:
//
//   npm run bench            a table
//   npm run bench -- --json  the same numbers as JSON, for a script or an agent
//
// Needs Node 22.18+ (it imports the TypeScript sources directly).
import { performance } from 'node:perf_hooks'

import { trimOutput } from '../src/core/trim.ts'
import { bigOutput, FIXTURES } from '../tests/fixtures/outputs.ts'

const ROUNDS = 5

/** The best of a few runs, in milliseconds: the least disturbed by the machine. */
const time = run => {
  let best = Number.POSITIVE_INFINITY

  for (let round = 0; round < ROUNDS; round += 1) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }

  return best
}

const rows = FIXTURES.map(make => {
  const fixture = make()
  const full = trimOutput(fixture.text, { level: 'full', maxLines: 300 })
  const lossless = trimOutput(fixture.text, { level: 'lossless', maxLines: 300 })
  const kept = fixture.mustKeep.every(line => full.text.split('\n').includes(line) && lossless.text.split('\n').includes(line))

  return {
    output: fixture.name,
    tokens: full.beforeTokens,
    full: full.afterTokens,
    lossless: lossless.afterTokens,
    savedFull: Math.round((1 - full.afterTokens / full.beforeTokens) * 100),
    savedLossless: Math.round((1 - lossless.afterTokens / lossless.beforeTokens) * 100),
    keptEveryError: kept,
    ms: Number(time(() => trimOutput(fixture.text)).toFixed(2)),
  }
})

const big = bigOutput()
const bigMs = time(() => trimOutput(big))
const throughput = { megabytes: Number((big.length / 1_000_000).toFixed(2)), ms: Number(bigMs.toFixed(1)) }

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, throughput }, null, 2))
} else {
  const head = ['output', 'tokens', 'full', 'saved', 'lossless', 'saved', 'errors kept', 'ms']
  const body = rows.map(row => [
    row.output,
    String(row.tokens),
    String(row.full),
    `${String(row.savedFull)}%`,
    String(row.lossless),
    `${String(row.savedLossless)}%`,
    row.keptEveryError ? 'yes' : 'NO',
    String(row.ms),
  ])
  const widths = head.map((title, column) => Math.max(title.length, ...body.map(row => row[column].length)))
  const line = cells => cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join('  ')

  console.log(line(head))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  body.forEach(row => console.log(line(row)))
  console.log(`\nthroughput: ${String(throughput.megabytes)} MB of mixed noise in ${String(throughput.ms)} ms`)
}

if (rows.some(row => !row.keptEveryError)) {
  process.exitCode = 1
}
