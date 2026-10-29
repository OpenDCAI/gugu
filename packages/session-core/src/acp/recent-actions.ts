import { toolDisplayName, type ToolNode, type TranscriptItem, type TranscriptTurn } from './models/turns'

/** The product-wide window used by presence and the recent-action popover. */
export const RECENT_ACTION_WINDOW_MS = 5 * 60 * 1000
export const RECENT_ACTION_MAX_ENTRIES = 60

export type RecentActionSummary = {
  /** Normalized tool names in chronological order. */
  actions: string[]
  /** Newest known tool timestamp, including actions outside the window. */
  lastActionAt: number | null
}

/** Keep the UI vocabulary independent of each provider's raw tool names. */
export function recentActionName(node: ToolNode): string | null {
  if (node.kind === 'execute-tool-call') return 'Bash'
  if (node.kind === 'read-tool-call') return 'Read'
  if (node.kind === 'search-tool-call') return 'Search'
  if (node.kind === 'web-fetch-tool-call') return 'Web'
  if (node.kind === 'mcp-tool-call') return toolDisplayName(node) || 'MCP'
  if (node.kind === 'spawn-subagent-tool-call') return 'Subagent'
  if (node.kind === 'create-plan-tool-call') return 'Plan'
  if (node.kind === 'patch-tool-call') return 'Edit'
  if (node.kind === 'unknown-tool-call') return node.name || null
  return null
}

function collectTools(
  items: readonly TranscriptItem[],
  at: number | undefined,
  out: Array<{ name: string; at: number }>
): void {
  for (const item of items) {
    if (item.kind === 'message' || item.kind === 'thinking' || item.kind === 'compaction' || item.kind === 'context-reset' || item.kind === 'session-notice') continue
    if (item.kind === 'tool-group') {
      collectTools(item.children, at, out)
      continue
    }
    const name = recentActionName(item)
    if (name && at !== undefined && Number.isFinite(at)) out.push({ name, at })
    if (item.children) collectTools(item.children, at, out)
  }
}

/**
 * Project the shared transcript shape into the small action payload used by
 * presence and the chat popover. Missing timestamps stay unknown instead of
 * being replaced with the reader's clock.
 */
export function recentActionsFromTurns(
  turns: readonly TranscriptTurn[],
  options: {
    nowMs?: number
    windowMs?: number
    maxEntries?: number
  } = {}
): RecentActionSummary {
  const nowMs = options.nowMs ?? Date.now()
  const windowMs = options.windowMs ?? RECENT_ACTION_WINDOW_MS
  const maxEntries = Math.max(0, options.maxEntries ?? RECENT_ACTION_MAX_ENTRIES)
  const entries: Array<{ name: string; at: number }> = []
  for (const turn of turns) collectTools(turn.items, turn.startedAt, entries)

  let lastActionAt: number | null = null
  for (const entry of entries) {
    if (lastActionAt === null || entry.at > lastActionAt) lastActionAt = entry.at
  }
  return {
    actions: entries
      .filter((entry) => nowMs - entry.at <= windowMs)
      .slice(maxEntries === 0 ? entries.length : -maxEntries)
      .map((entry) => entry.name),
    lastActionAt
  }
}
