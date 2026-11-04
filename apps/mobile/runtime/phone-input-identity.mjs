/** Job ids are derived hashes; the original client identity must travel alongside the actual Pi record id. */
export function phoneInputIdentity(turns, jobs, records = {}) {
  const clients = new Map()
  for (const [recordId, clientMessageId] of Object.entries(records)) clients.set(`pi:${recordId}#0`, clientMessageId)
  for (const job of jobs) if (job.clientMessageId) {
    clients.set(`phone-input:${job.id}`, job.clientMessageId)
    if (job.inputRecordId) clients.set(`pi:${job.inputRecordId}#0`, job.clientMessageId)
  }
  return turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    const clientMessageId = item.kind === 'message' && item.role === 'user' ? clients.get(item.id.split(':message:').at(-1)) : null
    return clientMessageId ? { ...item, _meta: { ...item._meta, guguClientMessageId: clientMessageId } } : item
  }) }))
}
