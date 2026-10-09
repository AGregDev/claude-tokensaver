/**
 * Deterministic task scoring. No model call: every signal is a regular
 * expression or a count over the task text, so scoring costs zero tokens.
 */

export const TASK_TYPES = [
  'search',
  'bulk-read',
  'repetitive-edit',
  'summarize',
  'edit',
  'reasoning',
  'general',
] as const

export type TaskType = (typeof TASK_TYPES)[number]

export const RISK_KINDS = ['security', 'destructive', 'production'] as const

export type RiskKind = (typeof RISK_KINDS)[number]

/** Each feature is normalised to 0..1. */
export type Features = {
  scope: number
  files: number
  ambiguity: number
  depth: number
  risk: number
}

export type TaskScore = {
  taskType: TaskType
  features: Features
  /** 0..100: how much reasoning the task needs, which is what picks the tier. */
  complexity: number
  isRisky: boolean
  risks: readonly RiskKind[]
  /** True when the heuristics cannot place the task with confidence. */
  isUnsure: boolean
}

export type TaskInput = {
  text: string
  description?: string | undefined
  subagentType?: string | undefined
}

const RISK_PATTERNS: Readonly<Record<RiskKind, RegExp>> = {
  security:
    /\b(auth(?:entication|orization|n|z)?|passwords?|passphrases?|secrets?|credentials?|(?:access|auth|api|bearer|refresh|session)[- ]tokens?|api[- ]?keys?|private keys?|encrypt\w*|decrypt\w*|oauth|jwt|csrf|xss|sql injection|vulnerab\w*|security|permissions?|sudo|chmod|chown|ssh|certificates?|iam|rbac|cve-\d+)\b|\.env\b/gi,
  destructive:
    /\b(rm -rf?|delete\w*|drop (?:table|database|schema|index)|truncate\w*|wipe\w*|purge\w*|destroy\w*|force[- ]push\w*|reset --hard|git clean|overwrit\w*|erase\w*|remove all|uninstall\w*|migrations?|rollback|format (?:the )?(?:disk|drive))\b|push (?:-f\b|--force)/gi,
  production:
    /\b(prod(?:uction)?|deploy\w*|releas\w*|live (?:site|system|server|database|db|traffic)|customer data|billing|payments?|invoic\w*|payroll|terraform|kubectl|kubernetes|infra(?:structure)?|ci\/cd|dns|rollout|hotfix)\b/gi,
}

/** Task types that can be told from the text. `general` is what is left. */
type KnownType = Exclude<TaskType, 'general'>

const TYPE_PATTERNS: Readonly<Record<KnownType, RegExp>> = {
  summarize:
    /\b(summari[sz]\w*|summary|tl;?dr|recap|digest|condense\w*|overview|gist)\b/gi,
  search:
    /\b(find|search\w*|grep|locate|look (?:for|up)|where (?:is|are|does|do)|which files?|list (?:all|every)|usages?|references? to|occurrences?|who calls|callers of)\b/gi,
  'bulk-read':
    /\b(read (?:all|every|each|through)|go through|scan\w*|inventory|catalogu?e?|survey|review (?:all|every|each)|collect (?:all|every)|gather\w*|crawl\w*)\b/gi,
  'repetitive-edit':
    /\b(renam\w*|replace (?:all|every|each)|(?:find|search) and replace|codemod|bulk|mass|in (?:all|every|each) files?|every (?:file|occurrence|instance)|across all files|update (?:all|every|each)|apply the same|convert (?:all|every|each)|reformat\w*|bump (?:all|the) versions?)\b/gi,
  reasoning:
    /\b(design\w*|architect\w*|why|root cause|debug\w*|diagnos\w*|race conditions?|deadlocks?|trade-?offs?|algorithms?|prove|optimi[sz]\w*|plan|strategy|investigat\w*|concurrency|refactor\w*|redesign\w*|evaluat\w*|compar\w*|decide|reason about|analy[sz]\w*|performance|memory leaks?)\b/gi,
  edit: /\b(fix\w*|implement\w*|add|chang\w*|writ\w*|updat\w*|creat\w*|modif\w*|remov\w*|edit\w*|patch\w*|build|make)\b/gi,
}

/**
 * Tie-break order: when two types match equally often, the one that routes
 * to the higher tier wins, so a tie never sends work to a cheaper model.
 */
const TYPE_PRIORITY: readonly KnownType[] = [
  'reasoning',
  'edit',
  'repetitive-edit',
  'summarize',
  'bulk-read',
  'search',
]

const SCOPE_PATTERN =
  /\b(all|every|each|entire|whole|across|everywhere|codebase|repo(?:sitory)?|project-wide|global(?:ly)?|monorepo|recursive(?:ly)?)\b|\*\*?\/|\*\.\w+/gi

const PATH_PATTERN =
  /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|rb|md|json|ya?ml|toml|s?css|html|sql|sh|c|cpp|h|cs|php|kt|swift)\b/gi

const FILE_COUNT_PATTERN = /\b(\d{1,4}) files?\b/i

const VAGUE_PATTERN =
  /\b(somehow|maybe|perhaps|something|stuff|things?|etc|whatever|figure out|not sure|i guess|kind of|sort of|improve\w*|better|clean ?up|tidy|polish|as needed|if needed|appropriate(?:ly)?)\b/gi

const IDENTIFIER_PATTERN = /`[^`]+`|\b[a-z]+[A-Z]\w*\b|\b\w+_\w+\b/g

const STEP_PATTERN = /\b(then|after that|afterwards|finally|next,)\b|^\s*\d+[.)]\s/gim

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

const matchesOf = (text: string, pattern: RegExp): readonly string[] =>
  Array.from(text.matchAll(pattern), match => match[0].toLowerCase())

const countOf = (text: string, pattern: RegExp): number => matchesOf(text, pattern).length

const wordCountOf = (text: string): number => text.split(/\s+/).filter(word => word !== '').length

const classify = (text: string): TaskType => {
  const ranked = TYPE_PRIORITY.map((type, priority) => ({
    type,
    priority,
    hits: countOf(text, TYPE_PATTERNS[type]),
  })).sort((a, b) => b.hits - a.hits || a.priority - b.priority)

  const best = ranked[0]

  return best === undefined || best.hits === 0 ? 'general' : best.type
}

const risksOf = (text: string): readonly RiskKind[] =>
  RISK_KINDS.filter(kind => countOf(text, RISK_PATTERNS[kind]) > 0)

const filesFeature = (text: string, scope: number): number => {
  const paths = new Set(matchesOf(text, PATH_PATTERN)).size
  const stated = Number(FILE_COUNT_PATTERN.exec(text)?.[1] ?? 0)
  const count = Math.max(paths, stated)

  // A broad task that names no file touches an unknown number of them.
  if (count === 0 && scope >= 0.34) {
    return 0.5
  }

  return clamp01(count / 8)
}

const ambiguityFeature = (text: string, words: number): number => {
  const anchors = countOf(text, IDENTIFIER_PATTERN) + new Set(matchesOf(text, PATH_PATTERN)).size
  const vague = countOf(text, VAGUE_PATTERN) / 3
  const isTerse = words < 6 && anchors === 0
  const isConcrete = anchors >= 2

  return clamp01(vague + (isTerse ? 0.4 : 0) - (isConcrete ? 0.2 : 0))
}

const depthFeature = (text: string, words: number): number => {
  const reasoning = countOf(text, TYPE_PATTERNS.reasoning) / 3
  const steps = Math.min(0.2, countOf(text, STEP_PATTERN) * 0.1)

  return clamp01(reasoning + steps + (words > 150 ? 0.2 : 0))
}

/** Scores a task from its text alone. Pure and deterministic. */
export const scoreTask = (input: TaskInput): TaskScore => {
  const text = [input.description ?? '', input.text].join('\n').trim()
  const words = wordCountOf(text)
  const scope = clamp01(countOf(text, SCOPE_PATTERN) / 3)
  const risks = risksOf(text)
  const riskHits = RISK_KINDS.reduce((sum, kind) => sum + countOf(text, RISK_PATTERNS[kind]), 0)
  const features: Features = {
    scope,
    files: filesFeature(text, scope),
    ambiguity: ambiguityFeature(text, words),
    depth: depthFeature(text, words),
    risk: clamp01(riskHits / 2),
  }
  const taskType = classify(text)
  const complexity = Math.round(
    100 *
      clamp01(
        0.45 * features.depth +
          0.25 * features.ambiguity +
          0.15 * features.scope +
          0.15 * features.files,
      ),
  )

  return {
    taskType,
    features,
    complexity,
    isRisky: risks.length > 0,
    risks,
    isUnsure: features.ambiguity >= 0.6 || taskType === 'general' || words < 3,
  }
}

export const isTaskType = (value: unknown): value is TaskType =>
  TASK_TYPES.some(type => type === value)
