/**
 * The caveman voice: Claude answers in fewer words with every technical fact
 * kept, so each reply costs fewer output tokens and weighs less in the context
 * every later request re-sends.
 *
 * The rules are adapted from Caveman by Julius Brussee
 * (https://github.com/juliusbrussee/caveman, Apache-2.0; see
 * third_party/caveman/NOTICE). Changes: the `caveman` and `ultracave` skills
 * condensed into one system-prompt section each, and their switch commands
 * replaced by tokensaver's. Pure: no Claude Code imports.
 */
import { isRecord } from './log.ts'

/** `caveman` is Caveman's default voice; `ultra` its `ultracave`, grammar stripped too. */
export type Voice = 'off' | 'caveman' | 'ultra'

export const VOICES: readonly Voice[] = ['off', 'caveman', 'ultra']

/** The system prompt section the voice rides in: tokensaver's own, after the cache boundary. */
export const VOICE_SECTION_ID = 'tokensaver:caveman'

const CAVEMAN_RULES = [
  '# Caveman voice',
  '',
  'Respond terse like smart caveman. All technical substance stay. Only fluff die. Every output token is billed and re-sent with each later request, so filler costs twice.',
  '',
  'This holds for every reply until the user switches it off (`/tokensaver caveman off`, "stop caveman" or "normal mode"). Confirm a switch-off in one line. Never announce the voice.',
  '',
  '1. Answer first, then the reason, then the next step: `[thing] [action] [reason]. [next step].` Bad: "Sure! I\'d be happy to help. The issue you\'re seeing is likely caused by..." Good: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"',
  '2. Kill ceremony: no greeting, hedging, pleasantries, recap or closer ("Sure!", "Let me", "I\'ll now", "Hope this helps"). No just/really/basically/actually/simply.',
  '3. Short words: "fix", not "implement a solution for". Standard acronyms are fine (DB, API, HTTP); invented abbreviations (cfg, impl, fn) and arrows are not.',
  '4. Articles optional, meaning never. Fragments are fine. Never drop not/never/no/only/except. Numbers and units exact. Bad: "Migration drop column backup first." Good: "Back up first. Then run migration: it drops the column."',
  '5. One idea per sentence, at most 20 words, active voice, imperative for instructions, one term per thing. When compression and clarity conflict, clarity wins.',
  '6. Payload verbatim: code blocks, commands, paths and API names exact; errors quoted exact, shortest decisive line only. Show a code change as the changed lines plus 1-2 lines of context, unless the file is new or the user asks for all of it. Never delete or shorten an existing comment you were not asked to change.',
  '7. Tool runs: no text between routine calls. One line before a multi-step run, one per phase change, one with the result.',
  "8. Keep the user's language: compress the style, not the language.",
  '9. Never perform caveman: no "me think", no prefix, no emoji or decorative tables, no word added to sound caveman. Plain phrasing shorter? Use it.',
  '',
  'Write plain, full sentences, then resume, for: a security warning; an irreversible action (confirm first); step order a fragment could scramble; a confused user or a repeated question; a question or options you put to the user; a status line or summary the harness asks for; and anything persisted outside the chat (code, comments, commits, PRs, docs, issues, memory files, messages to other people).',
  '',
  'Before sending: delete an opening sentence that announces what you will do and a closing one that recaps or offers help. Check every not/never/no/only, code span, path, number and error survived. Rewrite any sentence with two readings in full.',
].join('\n')

const ULTRA_RULES = [
  '',
  'Ultra: caveman with the grammar stripped too. Then cut again.',
  '- Fragments: drop articles, copulas and connectives while the order stays clear. Good: "Inline object prop, new ref, re-render. `useMemo`."',
  '- One word when one word is enough. Good: "Yes. Null check first."',
  '- Each fact once: no restating, no summary after a list.',
  '- Cut a conjunction only when the step order survives. Good: "Back up first. Then migrate: drops column."',
  '- A fragment no shorter than the sentence? Use the sentence.',
].join('\n')

/** The section text for a voice; undefined for `off`. */
export const voiceRules = (voice: Voice): string | undefined =>
  voice === 'off' ? undefined : voice === 'ultra' ? `${CAVEMAN_RULES}\n${ULTRA_RULES}` : CAVEMAN_RULES

/** Marks text tokensaver has already made terse, so it is never added twice. */
const REPORT_MARK = '(tokensaver: report terse)'

/**
 * What a sub-agent is told on top of its task: its report lands in the main
 * context and is re-sent with every later request, so it should be short.
 */
export const REPORT_NOTE = `${REPORT_MARK} Report back terse: findings first, no preamble, no recap. Fragments are fine. Keep every path, line number, command, error string and number exact, and never drop not/never/no/only. The report is re-read on every later request, so each word costs again.`

/** The sub-agent's task with the report note added, once. */
export const withReportNote = (prompt: string): string =>
  prompt.includes(REPORT_MARK) ? prompt : `${prompt.trimEnd()}\n\n${REPORT_NOTE}`

const SUMMARY_MARK = 'Write the summary itself terse'

/** A compaction's instructions, asking for a summary in the caveman voice. */
export const withTerseSummary = (instructions: string | undefined): string => {
  const ask = `${SUMMARY_MARK}, caveman style: fragments, no filler, each fact once; keep every path, command, decision, error, number and the latest request exact.`

  if (instructions === undefined || instructions.trim() === '') {
    return ask
  }

  return instructions.includes(SUMMARY_MARK) ? instructions : `${instructions.trim()} ${ask}`
}

/** Reads a voice from an option or a command word; undefined for anything else. */
export const parseVoice = (value: unknown): Voice | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  switch (value.trim().toLowerCase()) {
    case 'off':
    case 'normal':
    case 'stop':
      return 'off'
    case 'on':
    case 'caveman':
    case 'full':
    case 'lite':
      return 'caveman'
    case 'ultra':
    case 'ultracave':
      return 'ultra'
    default:
      return undefined
  }
}

/** Whole prompts that switch the voice, as Caveman's users type them. Anything longer is a task, not a switch. */
const SWITCHES: Readonly<Record<string, Voice>> = {
  'stop caveman': 'off',
  'stop caveman mode': 'off',
  'caveman off': 'off',
  'normal mode': 'off',
  'talk normally': 'off',
  'speak normally': 'off',
  'caveman mode': 'caveman',
  'caveman on': 'caveman',
  'talk like caveman': 'caveman',
  'talk like a caveman': 'caveman',
  'caveman ultra': 'ultra',
  'ultra caveman': 'ultra',
  ultracave: 'ultra',
}

/** The voice a prompt switches to when the whole prompt is a switch phrase; undefined otherwise. */
export const voiceSwitchOf = (text: string): Voice | undefined => {
  const phrase = text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')

  return Object.hasOwn(SWITCHES, phrase) ? SWITCHES[phrase] : undefined
}

/** What the person sees when the voice changes. */
export const voiceLine = (voice: Voice): string =>
  voice === 'off'
    ? 'Caveman voice off: Claude answers in its normal voice from the next reply.'
    : voice === 'ultra'
      ? 'Caveman voice ultra: fragments only, every fact kept, from the next reply.'
      : 'Caveman voice on: fewer words, every fact kept, from the next reply.'

/** What Claude is told beside a prompt that switched the voice, so it confirms rather than wonders. */
export const voiceNote = (voice: Voice): string =>
  voice === 'off'
    ? 'tokensaver: the person switched the caveman voice off. Answer in your normal voice from now on; confirm the switch in one short line.'
    : `tokensaver: the person switched the caveman voice ${voice === 'ultra' ? 'to ultra' : 'on'}; its rules are in your system prompt. Confirm the switch in one short line.`

/** Output tokens of finished main-loop replies, kept apart by voice so the two can be compared. */
export type ReplyTally = { turns: number; output: number }

export type VoiceStats = { terse: ReplyTally; plain: ReplyTally }

export const EMPTY_VOICE_STATS: VoiceStats = { terse: { turns: 0, output: 0 }, plain: { turns: 0, output: 0 } }

/** Below this many replies on a side, an average says nothing. */
export const MIN_COMPARED_TURNS = 5

const tallyOf = (value: unknown): ReplyTally => {
  const turns = isRecord(value) ? value['turns'] : undefined
  const output = isRecord(value) ? value['output'] : undefined

  return typeof turns === 'number' && typeof output === 'number' && turns >= 0 && output >= 0
    ? { turns, output }
    : { turns: 0, output: 0 }
}

export const parseVoiceStats = (value: unknown): VoiceStats =>
  isRecord(value) ? { terse: tallyOf(value['terse']), plain: tallyOf(value['plain']) } : EMPTY_VOICE_STATS

/** Adds one finished reply to its side. */
export const addReply = (stats: VoiceStats, input: { isTerse: boolean; output: number }): VoiceStats => {
  if (!Number.isFinite(input.output) || input.output <= 0) {
    return stats
  }

  const side = input.isTerse ? 'terse' : 'plain'

  return { ...stats, [side]: { turns: stats[side].turns + 1, output: stats[side].output + input.output } }
}

/** Average output tokens per reply on one side; 0 before the first. */
export const averageReply = (tally: ReplyTally): number =>
  tally.turns === 0 ? 0 : Math.round(tally.output / tally.turns)

/**
 * The measured difference, once both sides have enough replies: average output
 * tokens per reply with the voice and without it. Undefined until then.
 */
export const voiceComparison = (
  stats: VoiceStats,
): { terse: number; plain: number; cut: number } | undefined => {
  if (stats.terse.turns < MIN_COMPARED_TURNS || stats.plain.turns < MIN_COMPARED_TURNS) {
    return undefined
  }

  const terse = averageReply(stats.terse)
  const plain = averageReply(stats.plain)

  return { terse, plain, cut: plain === 0 ? 0 : Math.round(((plain - terse) / plain) * 100) }
}

