// @@@recent-action-model (#437) - pure helpers for the recent-action pop-out: aggregate the windowed

export interface RecentActionCount {
  name: string
  count: number
}

// Aggregate ["Bash","Bash","Edit","Bash"] → [{Bash,3},{Edit,1}], most-used first; ties keep first-seen
// order (Array.prototype.sort is stable).
export function countRecentActions(actions: readonly string[]): RecentActionCount[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const name of actions) {
    if (!name) continue
    if (!counts.has(name)) order.push(name)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return order
    .map((name) => ({ name, count: counts.get(name) ?? 0 }))
    .sort((a, b) => b.count - a.count)
}

// The host freezes the windowed actions at the last reported action, so once the agent has been idle
// longer than the window the cached counts no longer reflect "近 5 分钟". Gate the counts on the
// last-activity time so a stale burst isn't shown under that label. (#437)
const RECENT_ACTIVITY_WINDOW_MS = 5 * 60 * 1000

export function isRecentActivity(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
  windowMs: number = RECENT_ACTIVITY_WINDOW_MS
): boolean {
  if (!iso) return false
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  return nowMs - t <= windowMs
}

// @@@agent-action-tag (#791) - the current tool action = latest chronological non-empty entry, but only
// while still fresh (host freezes the window at the last action, so a long-idle agent's frozen burst must
// NOT read as "current"). Powers the group agent bar's inline text tag, e.g. "运行中 · Bash". null = nothing
// fresh to show → the tag falls back to the bare status label.
export function latestRecentAction(
  actions: readonly string[],
  lastActiveAt: string | null | undefined,
  nowMs: number = Date.now()
): string | null {
  if (!isRecentActivity(lastActiveAt, nowMs)) return null
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i]) return actions[i]
  }
  return null
}
