/**
 * The output trimmer: deterministic shrinking of noisy text before it is
 * stored in the conversation. Everything stored is re-sent on every later
 * request, so a token cut here is saved again and again until compaction.
 *
 * Two levels. `lossless` only removes what carries no information for the
 * model (colour codes, overwritten progress frames, trailing blanks, runs of
 * identical lines, counted). `full` also folds long runs of same-shaped lines
 * and caps a giant output to its head and tail, keeping every line in the cut
 * middle that looks like an error or a warning, and says exactly what it cut.
 */
import { estimateTokens } from './savings.ts'

export type TrimLevel = 'lossless' | 'full'

export type TrimOptions = {
  level: TrimLevel
  /** Above this many lines a `full` trim keeps the head and tail only. */
  maxLines: number
}

export const DEFAULT_TRIM: TrimOptions = { level: 'full', maxLines: 300 }

export type TrimAction = 'ansi' | 'progress' | 'blank' | 'repeat' | 'similar' | 'cap'

export type TrimResult = {
  text: string
  beforeTokens: number
  afterTokens: number
  actions: readonly TrimAction[]
}

/** A trim saving less than this is not worth changing what the model reads. */
export const MIN_TRIM_TOKENS = 40

const HEAD_SHARE = 0.55
const MAX_KEPT_SIGNALS = 40
const REPEAT_RUN = 3

/** Same-shape lines (differing only in numbers, hashes, quoted values): a run this long is folded. */
const SIMILAR = { minRun: 6, head: 2, tail: 1 } as const
/** Same-kind lines (one per crate, request or file, sharing their first word): only a long run is folded. */
const KINDRED = { minRun: 20, head: 3, tail: 2 } as const

// CSI sequences, OSC sequences (terminated by BEL or ST), and lone two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/** Lines that are the point of an output: never folded, never cut, whatever else goes. */
const ERROR =
  /\b(error|errors|failed|failure|fail|fatal|panic|exception|traceback|denied|refused|cannot|can't|undefined reference|segmentation fault|assert(ion)?)\b|✗|✖|×|✕|FAIL|ERR!/i

/** Warnings: kept from a cut middle after the errors, but a repetitive run of them may be folded. */
const WARNING = /\b(warning|warn|deprecated)\b/i

const isError = (line: string): boolean => ERROR.test(line)

const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** A carriage return without a newline redraws the line: only its last frame was ever visible. */
const lastFrame = (line: string): string => {
  const parts = line.split('\r').filter(part => part !== '')

  return parts.length === 0 ? '' : (parts[parts.length - 1] ?? '')
}

/**
 * The shape of a line: numbers and hashes blanked, so lines that differ only
 * in counts, timings or ids compare equal. Words and quoted text are kept: they
 * are what tells one test, file or message from another.
 */
export const shapeOf = (line: string): string =>
  line
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/\d+(\.\d+)*/g, '0')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Commands whose job is to show something (search, list, print, diff): their
 * output is what was asked for, so it is only ever trimmed losslessly.
 */
const INSPECTING =
  /(^|[|;&(]\s*|\bsudo\s+|\bxargs\s+)(cat|bat|less|more|head|tail|grep|egrep|fgrep|rg|ag|ack|find|fd|ls|dir|tree|stat|file|wc|jq|yq|awk|sed\s+-n|git\s+(show|diff|log|grep|blame|ls-files|status)|Get-Content|gc|type|Select-String|sls|Get-ChildItem|gci|Get-Item)\b/i

export const isInspecting = (command: string | undefined): boolean =>
  command !== undefined && INSPECTING.test(command.trim())

const collapseRepeats = (lines: readonly string[]): { lines: string[]; isChanged: boolean } => {
  const out: string[] = []
  let isChanged = false
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    let end = index + 1

    while (end < lines.length && lines[end] === line) {
      end += 1
    }

    const run = end - index

    if (run >= REPEAT_RUN && line.trim() !== '') {
      out.push(line, `  [… same line repeated ${String(run - 1)} more times]`)
      isChanged = true
    } else {
      out.push(...lines.slice(index, end))
    }

    index = end
  }

  return { lines: out, isChanged }
}

/** The kind of a line: the shape of its first word, for lines of three words or more. */
const kindOf = (line: string): string => {
  const words = line.trim().split(/\s+/)

  return words.length < 3 ? '' : shapeOf(words[0] ?? '')
}

/**
 * Folds runs of lines that share a key, keeping a few at each end and a count.
 * An error line has no key, so it ends a run and is always kept.
 */
const fold = (
  lines: readonly string[],
  keyOf: (line: string) => string,
  rule: { minRun: number; head: number; tail: number },
): { lines: string[]; isChanged: boolean } => {
  const keys = lines.map(line => (isError(line) ? '' : keyOf(line)))
  const out: string[] = []
  let isChanged = false
  let index = 0

  while (index < lines.length) {
    const key = keys[index] ?? ''
    let end = index + 1

    while (key !== '' && end < lines.length && keys[end] === key) {
      end += 1
    }

    const run = lines.slice(index, end)

    if (key !== '' && run.length >= rule.minRun) {
      out.push(
        ...run.slice(0, rule.head),
        `  [… ${String(run.length - rule.head - rule.tail)} more lines like these]`,
        ...run.slice(run.length - rule.tail),
      )
      isChanged = true
    } else {
      out.push(...run)
    }

    index = end
  }

  return { lines: out, isChanged }
}

const cap = (lines: readonly string[], maxLines: number): { lines: string[]; isChanged: boolean } => {
  if (lines.length <= maxLines) {
    return { lines: [...lines], isChanged: false }
  }

  const head = Math.floor(maxLines * HEAD_SHARE)
  const tail = maxLines - head
  const middle = lines.slice(head, lines.length - tail)
  // Errors first, then warnings, in the order they came.
  const errors = middle.filter(isError)
  const warnings = middle.filter(line => !isError(line) && WARNING.test(line))
  const kept = new Set([...errors, ...warnings].slice(0, MAX_KEPT_SIGNALS))
  const signals = middle.filter(line => kept.has(line))
  const omitted = middle.length - signals.length
  const note = `[tokensaver: ${String(omitted)} lines (~${String(estimateTokens(middle.join('\n')))} tokens) cut from the middle${signals.length > 0 ? `; the ${String(signals.length)} error/warning lines among them are kept below` : ''}. Re-run with a filter (grep, head, tail, sed -n) if you need them.]`

  return {
    lines: [...lines.slice(0, head), note, ...signals, ...(signals.length > 0 ? ['[tokensaver: end of kept lines]'] : []), ...lines.slice(lines.length - tail)],
    isChanged: true,
  }
}

/** Shrinks `text`; answers it unchanged (and no actions) when nothing worth cutting was found. */
export const trimOutput = (text: string, options: TrimOptions = DEFAULT_TRIM): TrimResult => {
  const beforeTokens = estimateTokens(text)
  const actions: TrimAction[] = []
  const unchanged: TrimResult = { text, beforeTokens, afterTokens: beforeTokens, actions: [] }

  if (text.length < 400) {
    return unchanged
  }

  const plain = stripAnsi(text)

  if (plain !== text) {
    actions.push('ansi')
  }

  const framed = plain.replace(/\r\n/g, '\n').split('\n').map(lastFrame)

  if (plain.includes('\r') && framed.join('\n') !== plain.replace(/\r\n/g, '\n')) {
    actions.push('progress')
  }

  // Trailing spaces go, and a run of blank lines becomes one.
  const tidy: string[] = []

  for (const line of framed.map(line => line.trimEnd())) {
    if (line === '' && tidy[tidy.length - 1] === '') {
      continue
    }

    tidy.push(line)
  }

  if (tidy.length < framed.length) {
    actions.push('blank')
  }

  const repeated = collapseRepeats(tidy)

  if (repeated.isChanged) {
    actions.push('repeat')
  }

  let lines = repeated.lines

  if (options.level === 'full') {
    const similar = fold(lines, shapeOf, SIMILAR)
    const kindred = fold(similar.lines, kindOf, KINDRED)

    if (similar.isChanged || kindred.isChanged) {
      actions.push('similar')
    }

    const capped = cap(kindred.lines, options.maxLines)

    if (capped.isChanged) {
      actions.push('cap')
    }

    lines = capped.lines
  }

  const trimmed = lines.join('\n').trim()
  const afterTokens = estimateTokens(trimmed)

  if (beforeTokens - afterTokens < MIN_TRIM_TOKENS) {
    return unchanged
  }

  return { text: trimmed, beforeTokens, afterTokens, actions }
}

/** True when pasted prompt text looks like a log worth cleaning, not prose the person wrote. */
export const looksLikeLog = (text: string): boolean => {
  if (text.length < 2000) {
    return false
  }

  // eslint-disable-next-line no-control-regex
  if (/\u001b\[|\r(?!\n)/.test(text)) {
    return true
  }

  const lines = text.split('\n')
  const shapes = new Set(lines.map(shapeOf))

  return lines.length >= 40 && shapes.size < lines.length * 0.6
}

export const ACTION_WORDS: Readonly<Record<TrimAction, string>> = {
  ansi: 'colour codes',
  progress: 'progress bars',
  blank: 'blank lines',
  repeat: 'repeated lines',
  similar: 'look-alike lines',
  cap: 'the middle of a huge log',
}
