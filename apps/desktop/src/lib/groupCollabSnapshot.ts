import type {
  GroupCollabSnapshot,
  GroupMemberItem,
} from '@gugu/core/shared/types/chat'

// A complete active_members snapshot owns the effective member set. Drop absent members,
// retain the previous order of survivors, and append newly visible identities.
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
