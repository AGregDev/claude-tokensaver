import { summarizeLog } from '../core/log.ts'
import type { TaskType } from '../core/score.ts'
import type { Tier } from '../core/tiers.ts'
import { activeCount } from '../runtime/session.ts'
import type { AgentNode, AgentStatus, Session, Spend } from '../runtime/session.ts'
import type { Theme } from './theme.ts'

export type ViewAgent = {
  key: string
  label: string
  tier: Tier | undefined
  taskType: TaskType
  status: AgentStatus
  tokens: number
  escalatedFrom: Tier | undefined
  /** One entry per ancestor level: true where a guide line still runs down beside this row. */
  guides: readonly boolean[]
  isLast: boolean
}

/** Everything the status line and the dashboard draw, as plain data. */
export type View = {
  mode: 'on' | 'off' | 'dry-run'
  hasNoColor: boolean
  hasReducedMotion: boolean
  hasStatusLine: boolean
  context: { tokens: number; window: number }
  spend: Spend
  total: number
  saved: number
  shownSaved: number
  keptOut: number
  history: readonly number[]
  agents: readonly ViewAgent[]
  activeCount: number
  learning: { count: number; cleanRate: number; escalations: number }
  notes: readonly string[]
  frame: number
}

const MAX_DEPTH = 4

/** Orders agents as a tree walk: each agent, then the agents it spawned. */
const walk = (
  nodes: readonly AgentNode[],
  parentAgentId: string | undefined,
  guides: readonly boolean[],
): readonly ViewAgent[] => {
  const known = new Set(nodes.flatMap(node => (node.agentId === undefined ? [] : [node.agentId])))
  const children = nodes.filter(node =>
    parentAgentId === undefined
      ? node.parentAgentId === undefined || !known.has(node.parentAgentId)
      : node.parentAgentId === parentAgentId,
  )

  return children.flatMap((node, index) => [
    {
      key: node.key,
      label: node.label,
      tier: node.tier,
      taskType: node.taskType,
      status: node.status,
      tokens: node.tokens,
      escalatedFrom: node.escalatedFrom,
      guides,
      isLast: index === children.length - 1,
    },
    ...(node.agentId === undefined || guides.length >= MAX_DEPTH
      ? []
      : walk(nodes, node.agentId, [...guides, index < children.length - 1])),
  ])
}

const modeOf = (session: Session): View['mode'] => {
  if (!session.config.isEnabled) {
    return 'off'
  }

  return session.config.isDryRun ? 'dry-run' : 'on'
}

export const toView = (session: Session): View => {
  const summary = summarizeLog(session.outcomes)

  return {
    mode: modeOf(session),
    hasNoColor: session.hasNoColor,
    hasReducedMotion: session.config.hasReducedMotion,
    hasStatusLine: session.config.hasStatusLine,
    context: session.context,
    spend: session.spend,
    total: session.spend.haiku + session.spend.sonnet + session.spend.opus + session.spend.other,
    saved: session.saved,
    shownSaved: session.shownSaved,
    keptOut: session.keptOut,
    history: session.savedHistory,
    agents: walk(session.agents, undefined, []),
    activeCount: activeCount(session),
    learning: {
      count: summary.count,
      cleanRate: summary.cleanRate,
      escalations: summary.escalations,
    },
    notes: session.notes,
    frame: session.frame,
  }
}

export const themeOf = (view: View): Theme => ({
  hasColor: !view.hasNoColor,
  hasMotion: !view.hasReducedMotion,
})
