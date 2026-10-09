/**
 * The session controller: every mod event becomes one pure transition,
 * `(session, input) -> { session, effects, reply }`. Nothing here touches
 * Claude Code; hooks/register.tsx feeds events in and carries effects out.
 */
import { checkResult, isUserRejection, planEscalation } from '../core/escalate.ts'
import type { CheckSignal } from '../core/escalate.ts'
import {
  appendOutcome,
  buildExport,
  nextSeq,
  parseLog,
  parseThresholds,
  summarizeLog,
} from '../core/log.ts'
import type { Outcome } from '../core/log.ts'
import { DEFAULT_THRESHOLDS, decideDelegation, resolveSpawnModel, routeTier } from '../core/route.ts'
import type { Thresholds } from '../core/route.ts'
import { contextSavings, estimateTokens, routingSavings } from '../core/savings.ts'
import { scoreTask } from '../core/score.ts'
import type { TaskType } from '../core/score.ts'
import { rankOf, rankOfModel, tierOfModel } from '../core/tiers.ts'
import type { Tier } from '../core/tiers.ts'
import { learnFromOutcome, tighten, tuneFromLog } from '../core/tune.ts'
import { DEFAULT_EXPORT_PATH, HELP_TEXT, parseCommand } from './commands.ts'
import { applyOverrides, isNoColor, parseOptions, parseOverrides } from './config.ts'
import type { Config, Overrides } from './config.ts'
import { formatTokens } from '../ui/format.ts'

export type AgentStatus = 'running' | 'retrying' | 'done' | 'failed' | 'planned'

/**
 * How an agent type gets its model when nobody names one: from its parent, or
 * from its own definition. Only the first kind is tokensaver's to route.
 */
export type AgentTypeModel = 'inherits' | 'own-model'

/** One sub-agent in the delegation tree. */
export type AgentNode = {
  /** The Agent tool call it belongs to. */
  key: string
  subagentType: string
  parentModel: string
  /** True for the first, untouched spawn of an agent type: it shows how the type picks its model. */
  isProbe: boolean
  agentId: string | undefined
  parentAgentId: string | undefined
  label: string
  taskType: TaskType
  /** The tier it runs on; undefined when it inherits a model tokensaver cannot name. */
  tier: Tier | undefined
  /** True when tokensaver chose its model. */
  isRouted: boolean
  escalatedFrom: Tier | undefined
  /** Set between a failed attempt and its retry: the tier the retry must use. */
  pendingTier: Tier | undefined
  status: AgentStatus
  tokens: number
  /** Tokens a failed attempt spent before its retry. */
  wastedTokens: number
  answerTokens: number
  attempts: number
  isBackground: boolean
  isDryRun: boolean
  /** True when tokensaver's hint asked for this delegation. */
  isHinted: boolean
  isRecorded: boolean
  /** The rank of the model it would have run on without tokensaver. */
  baselineRank: number | undefined
}

export type Spend = Readonly<Record<Tier | 'other', number>>

export type Session = {
  config: Config
  overrides: Overrides
  hasNoColor: boolean
  thresholds: Thresholds
  outcomes: readonly Outcome[]
  spend: Spend
  context: { tokens: number; window: number }
  /**
   * Estimated saving from running work on cheaper tiers, in tokens of the
   * model it would otherwise have run on, net of failed attempts and of
   * tokensaver's own hint. Negative when the overhead outweighs the gain.
   */
  saved: number
  /** Tokens of delegated work the main context never had to hold: the work less its summary. */
  keptOut: number
  savedHistory: readonly number[]
  agents: readonly AgentNode[]
  /** What this session has seen of each agent type; a type not listed has not been observed yet. */
  agentTypes: Readonly<Record<string, AgentTypeModel>>
  /** Delegations of the turn in progress, by key; the next prompt reads them to judge that turn. */
  turnKeys: readonly string[]
  /** Tiers to add to every routing decision this turn (after a user rejection). */
  boost: number
  isHintActive: boolean
  /** Turns whose usage arrived step by step, so their totals are not counted twice. */
  steppedTurns: readonly string[]
  notes: readonly string[]
  frame: number
  shownSaved: number
}

export type Effect =
  | { kind: 'toast'; text: string }
  | { kind: 'log'; text: string }
  | { kind: 'save-log' }
  | { kind: 'save-settings' }
  | { kind: 'clear-log' }
  | { kind: 'open-dashboard' }
  | { kind: 'export'; path: string; json: string }

export type Step<Reply> = {
  session: Session
  effects: readonly Effect[]
  reply: Reply
}

const MAX_AGENTS = 24
const MAX_HISTORY = 32
const MAX_NOTES = 4
const MAX_STEPPED_TURNS = 64
const HINT_NOUNS: Readonly<Record<TaskType, string>> = {
  search: 'search',
  'bulk-read': 'read-through',
  'repetitive-edit': 'repetitive edit',
  summarize: 'summarising job',
  edit: 'edit',
  reasoning: 'problem',
  general: 'task',
}

const still = <Reply>(session: Session, reply: Reply): Step<Reply> => ({
  session,
  effects: [],
  reply,
})

const shorten = (text: string, limit = 40): string => {
  const line = text.replace(/\s+/g, ' ').trim()

  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

const withNote = (session: Session, note: string): Session => ({
  ...session,
  notes: [...session.notes, note].slice(-MAX_NOTES),
})

const replaceAgent = (session: Session, node: AgentNode): Session => ({
  ...session,
  agents: session.agents.map(agent => (agent.key === node.key ? node : agent)),
})

const signalText = (signal: CheckSignal): string => signal.replace('-', ' ')

export type HydrateInput = {
  options: Readonly<Record<string, unknown>>
  storedLog: unknown
  storedThresholds: unknown
  storedSettings: unknown
  noColor: string | undefined
}

/** Builds the session from the plugin's options and whatever the local store holds. */
export const hydrate = (input: HydrateInput): Step<undefined> => {
  const log = parseLog(input.storedLog)
  const overrides = parseOverrides(input.storedSettings)
  const session: Session = {
    config: applyOverrides(parseOptions(input.options), overrides),
    overrides,
    hasNoColor: isNoColor(input.noColor),
    thresholds: tuneFromLog(parseThresholds(input.storedThresholds), log.outcomes),
    outcomes: log.outcomes,
    spend: { haiku: 0, sonnet: 0, opus: 0, other: 0 },
    context: { tokens: 0, window: 0 },
    saved: 0,
    keptOut: 0,
    savedHistory: [],
    agents: [],
    agentTypes: {},
    turnKeys: [],
    boost: 0,
    isHintActive: false,
    steppedTurns: [],
    notes: [],
    frame: 0,
    shownSaved: 0,
  }

  if (log.dropped === 0) {
    return still(session, undefined)
  }

  return {
    session,
    effects: [
      {
        kind: 'log',
        text: `tokensaver: ${String(log.dropped)} unreadable entr${log.dropped === 1 ? 'y' : 'ies'} dropped from the outcome log`,
      },
      { kind: 'save-log' },
    ],
    reply: undefined,
  }
}

export type PromptInput = {
  text: string
  /** True for a prompt the person typed; notifications and peers are not scored. */
  isFromUser: boolean
  now: number
}

/** A user rejection counts against every model tokensaver picked in the turn it rejects. */
const recordRejections = (session: Session, now: number): Session =>
  session.agents
    .filter(agent => session.turnKeys.includes(agent.key) && agent.isRouted && !agent.isDryRun)
    .reduce((current, agent) => {
      if (agent.tier === undefined) {
        return current
      }

      const outcome: Outcome = {
        seq: nextSeq(current.outcomes),
        at: now,
        taskType: agent.taskType,
        tier: agent.tier,
        tokens: agent.tokens,
        retries: agent.attempts,
        wasEscalated: agent.escalatedFrom !== undefined,
        isSuccess: false,
        signal: 'user-rejection',
      }

      return {
        ...current,
        outcomes: appendOutcome(current.outcomes, outcome),
        thresholds: tighten(current.thresholds, agent.taskType, agent.tier, outcome.seq),
      }
    }, session)

/**
 * A submitted prompt: judges the previous turn if the user rejects it, then
 * scores the new task and decides whether delegating would save tokens.
 */
export const onPrompt = (
  session: Session,
  input: PromptInput,
): Step<{ context: string | undefined }> => {
  if (!session.config.isEnabled || !input.isFromUser) {
    return still(session, { context: undefined })
  }

  const effects: Effect[] = []
  const hadRouted = session.agents.some(
    agent => session.turnKeys.includes(agent.key) && agent.isRouted && !agent.isDryRun,
  )
  const isRejected = hadRouted && isUserRejection(input.text)
  let next: Session = isRejected ? recordRejections(session, input.now) : session

  if (isRejected) {
    effects.push(
      { kind: 'toast', text: 'tokensaver: result rejected, routing one tier up this turn' },
      { kind: 'save-log' },
    )
    next = withNote(next, 'rejected: one tier up this turn')
  }

  const score = scoreTask({ text: input.text })
  const delegation = decideDelegation(score)
  const shouldHint =
    delegation.shouldDelegate && session.config.hasContextHint && !session.config.isDryRun
  const hint = `[tokensaver] This looks like a broad ${HINT_NOUNS[score.taskType]}. To keep the main context small, hand the bulk of it to one sub-agent and work from its summary.`

  if (delegation.shouldDelegate && session.config.isDryRun) {
    const text = `tokensaver dry-run: would suggest delegating this ${HINT_NOUNS[score.taskType]} (~${formatTokens(delegation.estimatedSavings)} tokens kept out of the main context)`
    effects.push({ kind: 'toast', text })
    next = withNote(next, text.replace('tokensaver ', ''))
  }

  return {
    session: {
      ...next,
      turnKeys: [],
      boost: isRejected ? 1 : 0,
      isHintActive: shouldHint,
      // The hint is the one thing tokensaver adds to the model's context: count it as a cost.
      saved: shouldHint ? next.saved - estimateTokens(hint) : next.saved,
    },
    effects,
    reply: { context: shouldHint ? hint : undefined },
  }
}

export type SpawnInput = {
  toolUseId: string
  prompt: string
  description: string
  subagentType: string
  explicitModel: string | undefined
  parentModel: string
  parentAgentId: string | undefined
  isBackground: boolean
  /** True for a fork, a teammate or a workflow agent: their model is not tokensaver's to set. */
  isPinned: boolean
}

/**
 * A sub-agent is about to start: scores its task and answers with the model
 * it should run on, or with nothing to leave the spawn untouched.
 */
export const onSpawn = (
  session: Session,
  input: SpawnInput,
): Step<{ model: string | undefined }> => {
  if (!session.config.isEnabled) {
    return still(session, { model: undefined })
  }

  const existing = session.agents.find(agent => agent.key === input.toolUseId)
  const label = shorten(input.description === '' ? input.prompt : input.description)
  const score = scoreTask({ text: input.prompt, description: input.description })
  const decision = routeTier(score, session.thresholds, session.boost)
  const known = session.agentTypes[input.subagentType]
  // An agent type may name its own model, and a spawn does not say whether it does. So
  // tokensaver sets a model only where that cannot override the type's choice: on a retry of
  // its own, on a model the caller named (which it only ever raises), or on a type it has
  // watched inherit its parent's model.
  const canRoute =
    !input.isPinned &&
    (existing?.pendingTier !== undefined || input.explicitModel !== undefined || known === 'inherits')
  const routing = canRoute
    ? resolveSpawnModel(decision, score, {
        parentModel: input.parentModel,
        explicitModel: input.explicitModel,
        forcedTier: existing?.pendingTier,
      })
    : { model: undefined, tier: undefined, note: 'the agent type picks its own model' }
  const isRouted = routing.model !== undefined
  const isDryRun = session.config.isDryRun
  const node: AgentNode = {
    key: input.toolUseId,
    subagentType: input.subagentType,
    parentModel: input.parentModel,
    isProbe:
      existing === undefined &&
      known === undefined &&
      !input.isPinned &&
      input.explicitModel === undefined,
    agentId: undefined,
    parentAgentId: input.parentAgentId,
    label,
    taskType: score.taskType,
    tier: routing.tier,
    isRouted,
    escalatedFrom: existing?.escalatedFrom,
    pendingTier: undefined,
    status: isDryRun ? 'planned' : 'running',
    tokens: existing?.tokens ?? 0,
    wastedTokens: existing?.wastedTokens ?? 0,
    answerTokens: 0,
    attempts: existing?.attempts ?? 0,
    isBackground: input.isBackground,
    isDryRun,
    isHinted: existing?.isHinted ?? session.isHintActive,
    isRecorded: false,
    // A retry keeps the baseline of the first attempt: what would have run without tokensaver.
    baselineRank: existing?.baselineRank ?? rankOfModel(input.explicitModel ?? input.parentModel),
  }
  const agents =
    existing === undefined
      ? [...session.agents, node].slice(-MAX_AGENTS)
      : session.agents.map(agent => (agent.key === node.key ? node : agent))
  const tracked: Session = {
    ...session,
    agents,
    turnKeys: session.turnKeys.includes(node.key) ? session.turnKeys : [...session.turnKeys, node.key],
  }

  if (!isRouted) {
    return still(tracked, { model: undefined })
  }

  const target = routing.tier ?? 'the parent model'

  if (isDryRun) {
    const text = `tokensaver dry-run: would run "${label}" on ${target} (${score.taskType})`

    return {
      session: withNote(tracked, text.replace('tokensaver ', '')),
      effects: [{ kind: 'toast', text }],
      reply: { model: undefined },
    }
  }

  const text =
    existing?.escalatedFrom === undefined
      ? `tokensaver: "${label}" → ${target} (${score.taskType})`
      : `tokensaver: escalated "${label}" ${existing.escalatedFrom} → ${target}`

  return {
    session: withNote(tracked, text.replace('tokensaver: ', '')),
    effects: [{ kind: 'toast', text }],
    reply: { model: routing.model },
  }
}

export type SpawnedInput = {
  toolUseId: string
  agentId: string | undefined
  isDenied: boolean
  /** The model Claude Code resolved for the sub-agent. */
  resolvedModel?: string | undefined
}

const isSameModel = (a: string, b: string): boolean => {
  const rank = rankOfModel(a)

  return a === b || (rank !== undefined && rank === rankOfModel(b))
}

/**
 * The spawn settled: remembers the agent's id, and from an untouched first
 * spawn learns whether its agent type inherits the parent's model. A refused
 * spawn is dropped.
 */
export const onSpawned = (session: Session, input: SpawnedInput): Step<undefined> => {
  const node = session.agents.find(agent => agent.key === input.toolUseId)

  if (node === undefined) {
    return still(session, undefined)
  }

  if (input.isDenied) {
    return still(replaceAgent(session, { ...node, status: 'failed', isRecorded: true }), undefined)
  }

  const started: AgentNode = {
    ...node,
    agentId: input.agentId,
    tier: node.isRouted ? node.tier : (tierOfModel(input.resolvedModel) ?? node.tier),
  }

  if (!node.isProbe || input.resolvedModel === undefined) {
    return still(replaceAgent(session, started), undefined)
  }

  const learned: AgentTypeModel = isSameModel(input.resolvedModel, node.parentModel)
    ? 'inherits'
    : 'own-model'
  const note =
    learned === 'inherits'
      ? `"${node.subagentType}" agents inherit their model: routing them from now on`
      : `"${node.subagentType}" agents choose their own model: left alone`

  return still(
    withNote(
      {
        ...replaceAgent(session, started),
        agentTypes: { ...session.agentTypes, [node.subagentType]: learned },
      },
      note,
    ),
    undefined,
  )
}

/** Books a finished delegation: its outcome, what it teaches, and what it saved. */
const finalize = (session: Session, node: AgentNode, signal: CheckSignal, now: number): Step<undefined> => {
  const isSuccess = signal === 'ok'
  const usefulTokens = Math.max(0, node.tokens - node.wastedTokens)
  // A dry run changed nothing, so it saved nothing.
  const routed =
    node.isRouted && !node.isDryRun && node.tier !== undefined && node.baselineRank !== undefined
      ? routingSavings(usefulTokens, rankOf(node.tier), node.baselineRank)
      : 0
  const kept =
    node.isHinted && !node.isDryRun && isSuccess
      ? contextSavings(usefulTokens, node.answerTokens)
      : 0
  const done: AgentNode = { ...node, status: isSuccess ? 'done' : 'failed', isRecorded: true }
  const settled: Session = {
    ...replaceAgent(session, done),
    // Two different savings, kept apart: adding them would count the same tokens twice.
    saved: session.saved + routed - node.wastedTokens,
    keptOut: session.keptOut + kept,
  }

  // The log records tokensaver's own decisions; a model it did not pick teaches it nothing.
  if (!node.isRouted || node.tier === undefined || node.isDryRun) {
    return still(settled, undefined)
  }

  const outcome: Outcome = {
    seq: nextSeq(session.outcomes),
    at: now,
    taskType: node.taskType,
    tier: node.tier,
    tokens: node.tokens,
    retries: node.attempts,
    wasEscalated: node.escalatedFrom !== undefined,
    isSuccess,
    signal,
  }
  const outcomes = appendOutcome(session.outcomes, outcome)

  return {
    session: {
      ...settled,
      outcomes,
      thresholds: learnFromOutcome(session.thresholds, outcomes, outcome),
    },
    effects: [{ kind: 'save-log' }],
    reply: undefined,
  }
}

export type AgentResultInput = {
  toolUseId: string
  isDenied: boolean
  isError: boolean
  text: string
  /** The Agent tool's own token total, used when no step usage was seen. */
  totalTokens: number | undefined
  now: number
}

/**
 * An Agent call returned. A result that fails its checks on a tier
 * tokensaver picked is retried once, one tier up; anything else is final.
 */
export const onAgentResult = (
  session: Session,
  input: AgentResultInput,
): Step<{ retryWith: Tier | undefined }> => {
  const found = session.agents.find(agent => agent.key === input.toolUseId)

  if (!session.config.isEnabled || found === undefined || found.isRecorded) {
    return still(session, { retryWith: undefined })
  }

  // A background agent's call returns as it starts; its turn.complete settles it.
  if (found.isBackground && !input.isDenied && !input.isError) {
    return still(session, { retryWith: undefined })
  }

  const node: AgentNode =
    found.tokens === 0 && input.totalTokens !== undefined
      ? { ...found, tokens: input.totalTokens }
      : found

  // A denial is a permission decision, not a quality signal: no retry, no outcome.
  if (input.isDenied) {
    return still(replaceAgent(session, { ...node, status: 'failed', isRecorded: true }), {
      retryWith: undefined,
    })
  }

  const signal = checkResult({ isError: input.isError, text: input.text })
  const plan = planEscalation({
    signal,
    tier: node.isRouted ? node.tier : undefined,
    attempts: node.attempts,
    isDenied: input.isDenied,
    isDryRun: node.isDryRun,
  })

  if (!plan.shouldEscalate || node.tier === undefined) {
    return { ...finalize(session, node, signal, input.now), reply: { retryWith: undefined } }
  }

  const retrying: AgentNode = {
    ...node,
    status: 'retrying',
    escalatedFrom: node.tier,
    pendingTier: plan.to,
    attempts: node.attempts + 1,
    wastedTokens: node.tokens,
  }
  const text = `tokensaver: "${node.label}" failed on ${node.tier} (${signalText(signal)}), retrying on ${plan.to}`

  return {
    session: withNote(
      {
        ...replaceAgent(session, retrying),
        // Tighten now, not when the retry finishes: the cheaper tier has already failed.
        thresholds: tighten(session.thresholds, node.taskType, node.tier, nextSeq(session.outcomes)),
      },
      text.replace('tokensaver: ', ''),
    ),
    effects: [{ kind: 'toast', text }, { kind: 'save-log' }],
    reply: { retryWith: plan.to },
  }
}

export type Usage = {
  model: string
  input: number
  output: number
  cacheWrite: number
}

const applyUsage = (session: Session, agentId: string | undefined, usage: Usage): Session => {
  // Cache reads are left out: they are re-read context, not new work.
  const tokens = usage.input + usage.output + usage.cacheWrite
  const bucket = tierOfModel(usage.model) ?? 'other'
  const spend = { ...session.spend, [bucket]: session.spend[bucket] + tokens }

  return {
    ...session,
    spend,
    agents:
      agentId === undefined
        ? session.agents
        : session.agents.map(agent =>
            agent.agentId === agentId ? { ...agent, tokens: agent.tokens + tokens } : agent,
          ),
  }
}

export type StepUsageInput = {
  turnId: string
  agentId: string | undefined
  usage: Usage
}

/** One model request finished: adds its tokens to the meter and to its agent. */
export const onStepUsage = (session: Session, input: StepUsageInput): Step<undefined> => {
  if (!session.config.isEnabled) {
    return still(session, undefined)
  }

  const stepKey = `${input.turnId}/${input.agentId ?? 'main'}`

  return still(
    {
      ...applyUsage(session, input.agentId, input.usage),
      steppedTurns: session.steppedTurns.includes(stepKey)
        ? session.steppedTurns
        : [...session.steppedTurns, stepKey].slice(-MAX_STEPPED_TURNS),
    },
    undefined,
  )
}

export type TurnCompleteInput = {
  turnId: string
  agentId: string | undefined
  /** The turn's totals; used only when no step of this turn reported usage. */
  usage: Usage | undefined
  isFailed: boolean
  /** True when the user interrupted the turn. */
  isAborted: boolean
  answer: string
  now: number
}

/** A turn ended: the main loop's closes the books on the turn, a sub-agent's on itself. */
export const onTurnComplete = (session: Session, input: TurnCompleteInput): Step<undefined> => {
  if (!session.config.isEnabled) {
    return still(session, undefined)
  }

  const stepKey = `${input.turnId}/${input.agentId ?? 'main'}`
  const counted =
    input.usage === undefined || session.steppedTurns.includes(stepKey)
      ? session
      : applyUsage(session, input.agentId, input.usage)

  if (input.agentId === undefined) {
    return still(
      { ...counted, savedHistory: [...counted.savedHistory, counted.saved].slice(-MAX_HISTORY) },
      undefined,
    )
  }

  const node = counted.agents.find(agent => agent.agentId === input.agentId)

  if (node === undefined || node.isRecorded) {
    return still(counted, undefined)
  }

  // An interrupt is the user's choice, not a quality signal: no outcome, and never a retry.
  if (input.isAborted) {
    return still(replaceAgent(counted, { ...node, status: 'failed', isRecorded: true }), undefined)
  }

  const answered: AgentNode = { ...node, answerTokens: estimateTokens(input.answer) }

  // A foreground agent is settled by its Agent call, which can still retry it.
  if (!node.isBackground) {
    return still(replaceAgent(counted, answered), undefined)
  }

  const signal = checkResult({ isError: input.isFailed, text: input.answer })

  return finalize(replaceAgent(counted, answered), answered, signal, input.now)
}

/** The context window moved: feeds the live meter. */
export const onMeasure = (
  session: Session,
  input: { tokens: number | undefined; window: number },
): Step<undefined> =>
  still({ ...session, context: { tokens: input.tokens ?? session.context.tokens, window: input.window } }, undefined)

export const activeCount = (session: Session): number =>
  session.agents.filter(agent => agent.status === 'running' || agent.status === 'retrying').length

/** True while something on screen is still moving. */
export const isAnimating = (session: Session): boolean =>
  session.config.isEnabled &&
  !session.config.hasReducedMotion &&
  (activeCount(session) > 0 || session.shownSaved !== session.saved)

/** One animation frame: turns the spinner and eases the saved counter toward its value. */
export const onTick = (session: Session): Step<undefined> => {
  if (session.config.hasReducedMotion) {
    return still({ ...session, shownSaved: session.saved }, undefined)
  }

  const gap = session.saved - session.shownSaved
  const move = Math.abs(gap) <= 3 ? gap : Math.trunc(gap / 3)

  return still(
    { ...session, frame: session.frame + 1, shownSaved: session.shownSaved + move },
    undefined,
  )
}

const modeOf = (config: Config): string => {
  if (!config.isEnabled) {
    return 'off'
  }

  return config.isDryRun ? 'dry-run' : 'on'
}

const statusReport = (session: Session): string => {
  const summary = summarizeLog(session.outcomes)
  const total = session.spend.haiku + session.spend.sonnet + session.spend.opus + session.spend.other

  return [
    `tokensaver is ${modeOf(session.config)}`,
    `${formatTokens(total)} tokens this session (haiku ${formatTokens(session.spend.haiku)}, sonnet ${formatTokens(session.spend.sonnet)}, opus ${formatTokens(session.spend.opus)})`,
    `~${formatTokens(session.saved)} saved by routing (estimate), ${formatTokens(session.keptOut)} kept out of the main context`,
    `${String(summary.count)} logged outcomes, ${String(Math.round(summary.cleanRate * 100))}% clean, ${String(summary.escalations)} escalations`,
  ].join(' · ')
}

const withOverride = (session: Session, overrides: Overrides, text: string): Step<undefined> => {
  const merged = { ...session.overrides, ...overrides }

  return {
    session: { ...session, overrides: merged, config: applyOverrides(session.config, merged) },
    effects: [{ kind: 'save-settings' }, { kind: 'log', text }],
    reply: undefined,
  }
}

/**
 * `/tokensaver <args>`. Every answer is an effect drawn outside the
 * transcript the model reads, so a command never adds tokens to its context.
 */
export const onCommand = (session: Session, args: string, now: number): Step<undefined> => {
  const command = parseCommand(args)

  switch (command.kind) {
    case 'status':
      return { session, effects: [{ kind: 'log', text: statusReport(session) }], reply: undefined }
    case 'help':
      return { session, effects: [{ kind: 'log', text: HELP_TEXT }], reply: undefined }
    case 'dashboard':
      return { session, effects: [{ kind: 'open-dashboard' }], reply: undefined }
    case 'enable':
      return withOverride(
        session,
        { isEnabled: command.value },
        `tokensaver is ${command.value ? 'on' : 'off'}`,
      )
    case 'dry-run': {
      const isDryRun = command.value ?? !session.config.isDryRun

      return withOverride(session, { isDryRun }, `tokensaver dry-run is ${isDryRun ? 'on' : 'off'}`)
    }
    case 'motion': {
      const hasMotion = command.value ?? session.config.hasReducedMotion

      return withOverride(
        { ...session, shownSaved: session.saved },
        { hasReducedMotion: !hasMotion },
        `tokensaver animations are ${hasMotion ? 'on' : 'off'}`,
      )
    }
    case 'reset':
      return {
        session: {
          ...session,
          outcomes: [],
          thresholds: DEFAULT_THRESHOLDS,
          saved: 0,
          keptOut: 0,
          shownSaved: 0,
          savedHistory: [],
        },
        effects: [
          { kind: 'clear-log' },
          { kind: 'log', text: 'tokensaver: outcome log and learned thresholds cleared' },
        ],
        reply: undefined,
      }
    case 'export': {
      const path = command.path ?? DEFAULT_EXPORT_PATH
      const json = JSON.stringify(buildExport(session.outcomes, session.thresholds, now), null, 2)

      return {
        session,
        effects: [
          { kind: 'export', path, json },
          {
            kind: 'log',
            text: `tokensaver: wrote ${String(session.outcomes.length)} outcomes to ${path} (local file, nothing was sent anywhere)`,
          },
        ],
        reply: undefined,
      }
    }
    case 'unknown':
      return {
        session,
        effects: [
          { kind: 'log', text: `tokensaver: unknown command "${command.word}"\n${HELP_TEXT}` },
        ],
        reply: undefined,
      }
  }
}
