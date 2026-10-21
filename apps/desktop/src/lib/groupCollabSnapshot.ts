import type {
  GroupCollabSnapshot,
  GroupMemberItem,
} from '@gugu/core/shared/types/chat'

// @@@2247 - authoritative-load reconcile (allow-shrink) for the group member set. A FULL authoritative
// getGroupCollab result is the source of truth for membership: chat_members' SELECT RLS is
// `is_member(chat_id)` (chat-level, all-or-nothing), so a non-empty read is complete — an empty/failed read
// is retried and thrown by getGroupCollab, so it never reaches here silently short. So a member absent from
// `next` was removed from the group server-side and MUST disappear — else it lingers as a permanent ghost
// (header count + member list stay one-too-high across reopen/restart, #2247). Prev order is preserved for
// surviving members (stable scroll geometry); removed members are dropped; genuinely-new members appended.
// (Supersedes the pre-#2247 never-shrink SWR merge: because chat_members is all-or-nothing, the transient
// 17-of-21 partial that once motivated never-shrink cannot occur — a sub-full read is empty, hence retried.)
export function reconcileCollabMembers<T extends GroupMemberItem>(prev: T[], next: T[]): T[] {
  if (prev.length === 0) return next
  const nextById = new Map(next.map((m) => [m.id, m]))
  const seen = new Set<string>()
  const merged: T[] = []
  for (const p of prev) {
    const fresh = nextById.get(p.id)
    if (fresh) {
      merged.push(fresh)
      seen.add(p.id)
    }
  }
  for (const n of next) {
    if (!seen.has(n.id)) merged.push(n)
  }
  return merged
}

// @@@2247 - snapshot-level allow-shrink reconcile for the authoritative full load: shrinks the member sets
// to the authoritative truth, and replaces the single-fetch scheduler / tasks / outputs state fresh.
export function reconcileGroupCollabSnapshot(
  prev: GroupCollabSnapshot,
  next: GroupCollabSnapshot,
): GroupCollabSnapshot {
  return {
    scheduler: next.scheduler,
    tasks: next.tasks,
    outputs: next.outputs,
    humans: reconcileCollabMembers(prev.humans, next.humans),
    agents: reconcileCollabMembers(prev.agents, next.agents),
  }
}

// @@@1877 删除本机 Agent 后，已打开的群成员抽屉必须立即把该 Agent 从名册剔除。用于删除事件的即时乐观收敛
// (头栏「N 名成员」计数 + 成员列表 + 在线点)，与后端 remove_owned_agent 已删 chat_members/identity 真值一致。
// 权威 refetch 的收敛由 reconcileCollabMembers 的 allow-shrink 兜住;本函数覆盖「删除事件已到、下次权威读未到」
// 的即时窗口。
export function removeAgentFromGroupCollab(
  snapshot: GroupCollabSnapshot,
  agentUserId: string,
): GroupCollabSnapshot {
  if (!snapshot.agents.some((agent) => agent.id === agentUserId)) return snapshot
  return { ...snapshot, agents: snapshot.agents.filter((agent) => agent.id !== agentUserId) }
}
