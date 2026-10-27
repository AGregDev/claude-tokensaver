import { describe, expect, it } from 'vitest'

import { isInspecting, looksLikeLog, MIN_TRIM_TOKENS, shapeOf, trimOutput } from '../../src/core/trim.ts'

const lines = (count: number, make: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => make(index)).join('\n')

describe('trimOutput', () => {
  it('leaves short output alone', () => {
    const result = trimOutput('ok\n')

    expect(result.text).toBe('ok\n')
    expect(result.actions).toEqual([])
  })

  it('strips colour codes and keeps the words', () => {
    const text = lines(60, index => `\u001b[32m✓\u001b[0m passed test number ${String(index)} in module alpha`)
    const result = trimOutput(text)

    expect(result.text).not.toContain('\u001b')
    expect(result.text).toContain('passed test number 0 in module alpha')
    expect(result.actions).toContain('ansi')
  })

  it('keeps only the last frame of a progress bar', () => {
    const frames = Array.from({ length: 80 }, (_, index) => `downloading ${String(index)}%`).join('\r')
    const result = trimOutput(`${frames}\rdone\nnext line`)

    expect(result.text).toBe('done\nnext line')
    expect(result.actions).toContain('progress')
  })

  it('counts repeated lines instead of keeping them', () => {
    const text = `start\n${lines(200, () => 'npm WARN deprecated something@1.0.0')}\nend`
    const result = trimOutput(text, { level: 'lossless', maxLines: 10_000 })

    expect(result.text).toContain('same line repeated 199 more times')
    expect(result.afterTokens).toBeLessThan(result.beforeTokens - MIN_TRIM_TOKENS)
  })

  it('folds look-alike lines under the full level only', () => {
    const text = lines(120, index => `Compiling crate-${String(index)} v0.${String(index)}.0`)

    expect(trimOutput(text, { level: 'full', maxLines: 10_000 }).text).toContain('more lines like these')
    expect(trimOutput(text, { level: 'lossless', maxLines: 10_000 }).text).not.toContain('more lines like these')
  })

  it('drops finished progress-bar lines under the full level only, and keeps bare rules', () => {
    const bar = '     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 13.0/13.0 kB 1.1 MB/s eta 0:00:00'
    const text = lines(40, index => (index % 2 === 0 ? `Fetched archive number ${String(index)} of the set` : bar))
    const full = trimOutput(`${text}
--------------------
[==========] 100%? no: ok`, { level: 'full', maxLines: 10_000 })

    expect(full.text).not.toContain('━━━━')
    expect(full.text).toContain('--------------------')
    expect(full.actions).toContain('progress')
    expect(trimOutput(text, { level: 'lossless', maxLines: 10_000 }).text).toContain('━━━━')
  })

  it('folds repeating groups of look-alike lines to the first and last group', () => {
    const text = lines(30, index => `Step ${String(index)}/30 : RUN make step-${String(index)}
 ---> Running in ${String(index)}a1b2c3d4e5`)
    const result = trimOutput(text, { level: 'full', maxLines: 10_000 }).text

    expect(result).toContain('Step 0/30 : RUN make step-0')
    expect(result).toContain(' ---> Running in 29a1b2c3d4e5')
    expect(result).toContain('[… 28 more groups of 2 lines like these]')
    expect(trimOutput(text, { level: 'lossless', maxLines: 10_000 }).text).toContain('Step 15/30')
  })

  it('never folds groups around warning lines', () => {
    const text = lines(20, index => `warn step ${String(index)}
npm notice fetched left-pad ${String(index)}
compiled module ${String(index)}`)

    expect(trimOutput(text, { level: 'full', maxLines: 10_000 }).text).toContain('warn step 10')
  })

  it('never folds a group that holds an error line', () => {
    const text = lines(30, index =>
      `step ${String(index)} started on worker ${String(index % 4)}
${index === 17 ? 'step 17 failed: exit code 2' : `step ${String(index)} finished in ${String(index)}ms`}`,
    )

    expect(trimOutput(text, { level: 'full', maxLines: 10_000 }).text).toContain('step 17 failed: exit code 2')
  })

  it('never folds error lines', () => {
    const text = lines(80, index => `error[E0${String(100 + index)}]: mismatched types in file_${String(index)}.rs`)

    expect(trimOutput(text, { level: 'full', maxLines: 10_000 }).text).toContain('file_40.rs')
  })

  it('caps a huge output to head and tail, keeping errors from the middle', () => {
    // Every line starts with its own word, so nothing folds and only the cap can shrink it.
    const word = (index: number): string =>
      [index % 26, Math.floor(index / 26) % 26, Math.floor(index / 676)].map(code => String.fromCharCode(97 + code)).join('')
    const text = lines(3000, index =>
      index === 1500 ? 'FATAL: connection refused at step 1500' : `${word(index)} wrote record ${String(index)} ok`,
    )
    const result = trimOutput(text, { level: 'full', maxLines: 200 })

    expect(result.actions).toContain('cap')
    expect(result.text).toContain('FATAL: connection refused at step 1500')
    expect(result.text).toContain('cut from the middle')
    expect(result.text).toContain('record 2999')
    expect(result.text.split('\n').length).toBeLessThan(260)
  })
})

describe('shapeOf', () => {
  it('treats lines that differ only in numbers as alike', () => {
    expect(shapeOf('took 12ms (3 files)')).toBe(shapeOf('took 940ms (17 files)'))
  })
})

describe('looksLikeLog', () => {
  it('spots a pasted log and leaves prose alone', () => {
    expect(looksLikeLog(lines(100, index => `[INFO] request ${String(index)} handled in 3ms`))).toBe(true)
    expect(looksLikeLog('Please refactor the parser. '.repeat(100))).toBe(false)
  })
})

describe('isInspecting', () => {
  it('knows a search, a listing or a print from a build', () => {
    for (const command of ['grep -rn foo src', 'rg parseConfig', 'git diff HEAD~1', 'ls -la', 'npm test 2>&1 | tail -40', 'Get-Content log.txt', 'cd app && cat README.md']) {
      expect(isInspecting(command)).toBe(true)
    }

    for (const command of ['npm install', 'cargo build --release', 'pytest -q', 'docker build .', undefined]) {
      expect(isInspecting(command)).toBe(false)
    }
  })
})
