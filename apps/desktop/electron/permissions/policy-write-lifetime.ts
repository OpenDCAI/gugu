/** Local invalidation around the existing settings write, never a policy/approval cache. */
type Writes = { pending: number; listeners: Set<(pending: boolean) => void> }
const owners = new Map<string, Writes>()
const state = (ownerId: string): Writes => {
  let value = owners.get(ownerId)
  if (!value) { value = { pending: 0, listeners: new Set() }; owners.set(ownerId, value) }
  return value
}
const collect = (ownerId: string, value: Writes) => {
  if (!value.pending && !value.listeners.size) owners.delete(ownerId)
}
const notify = (value: Writes) => {
  for (const listener of [...value.listeners]) listener(value.pending > 0)
}

export function observePermissionPolicyWrites(ownerId: string, listener: (pending: boolean) => void): () => void {
  const value = state(ownerId)
  value.listeners.add(listener); listener(value.pending > 0)
  return () => { value.listeners.delete(listener); collect(ownerId, value) }
}

/** Called after owner/input validation and BEFORE the first await or settings I/O. */
export function beginPermissionPolicyWrite(ownerId: string): () => void {
  const value = state(ownerId)
  value.pending++; notify(value)
  let finished = false
  return () => {
    if (finished) return
    finished = true; value.pending--; notify(value); collect(ownerId, value)
  }
}
