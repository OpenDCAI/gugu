/** Old host-owned queue rows keep their execution slots until they drain after an upgrade. */
export function sessionSendQueueOrder(current: readonly string[], local: ReadonlySet<string>, next: readonly string[]): { local: string[]; host: string[] } | null {
  if (next.length !== current.length || new Set(next).size !== next.length || next.some(id => !current.includes(id))) return null
  // A cross-owner drag cannot reorder execution atomically. Keep the existing row positions without a toast.
  if (next.some((id, index) => local.has(id) !== local.has(current[index]!))) return null
  return { local: next.filter(id => local.has(id)), host: next.filter(id => !local.has(id)) }
}
