// @@@2073 recent-action window — the ACP tool-timeline path (#966 gate B) only ever wrote
// `recent_tool_type` (the single latest tool). The per-tool「近 5 分钟」list `recent_actions` that the
// group running-card + hover popover (#437) read was left empty for every ACP agent, because the old
// producer that filled it (a JSONL scan of the terminal stack) was removed with that stack. So the popover's
// per-tool counts were structurally always empty.
//
// This is the small windowed accumulator that restores it, ACP-native: push one entry per tool
// INVOCATION, keep a rolling window, and expose (a) the flat tool-name list the renderer's
// `countRecentActions` tallies, and (b) the newest action time the freshness guard (#437) gates on.
// Pure + injectable clock so it unit-tests without a live runtime.

export interface RecentActionEntry {
  tool: string
  atMs: number
}

// Matches the renderer's freshness window (agentRecentActionModel RECENT_ACTIVITY_WINDOW_MS, #437): the
// card labels the counts「近 5 分钟」and hides them once the newest action is older than this.
export const RECENT_ACTION_WINDOW_MS = 5 * 60 * 1000
// Bound the per-agent memory: the popover shows the top 6 and a 5-min burst rarely exceeds this. A very
// chatty agent just keeps its newest N tool calls — the counts stay representative of「近 5 分钟」.
export const RECENT_ACTION_MAX_ENTRIES = 60

// Append one tool invocation, dropping entries that fell out of the window, then cap the length. Returns a
// new array (never mutates the input) so callers can store the result back without aliasing surprises.
export function pushRecentAction(
  entries: readonly RecentActionEntry[],
  tool: string,
  atMs: number,
  windowMs: number = RECENT_ACTION_WINDOW_MS,
  maxEntries: number = RECENT_ACTION_MAX_ENTRIES,
): RecentActionEntry[] {
  const kept = entries.filter((e) => atMs - e.atMs <= windowMs)
  kept.push({ tool, atMs })
  return kept.length > maxEntries ? kept.slice(kept.length - maxEntries) : kept
}

// The flat tool-name list, chronological (oldest→newest), one element per invocation — exactly the shape
// `recent_actions` (text[]) stores and the renderer's countRecentActions expects. The latest action is the
// last element (the popover highlights it, #690).
export function recentActionList(entries: readonly RecentActionEntry[]): string[] {
  return entries.map((e) => e.tool)
}

// ISO timestamp of the newest action, or null when the window is empty. Feeds `last_action_at`, which the
// renderer freshness guard (isRecentActivity, #437) compares against「近 5 分钟」.
export function lastActionAtIso(entries: readonly RecentActionEntry[]): string | null {
  const last = entries[entries.length - 1]
  return last ? new Date(last.atMs).toISOString() : null
}
