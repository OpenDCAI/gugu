import type { PersonalConversationHiding } from './hideListedConversation'

type PendingHide = { operationId: string; boundary: AbortSignal; receipt?: PersonalConversationHiding; inFlight?: Promise<void> }

/** No automatic replay. An explicit retry retains its operation and any confirmed receipt. */
export function createConversationHider(deps: {
  hide: (chatId: string, operationId: string) => Promise<PersonalConversationHiding>
  confirm: (accountId: string, receipt: PersonalConversationHiding) => Promise<void>
  boundary: () => AbortSignal
  operationId: () => string
}) {
  const pending = new Map<string, PendingHide>()
  return (accountId: string, chatId: string): Promise<void> => {
    const key = `${accountId}/${chatId}`, boundary = deps.boundary()
    if (boundary.aborted) return Promise.resolve()
    let entry = pending.get(key)
    if (!entry || entry.boundary !== boundary) {
      entry = { operationId: deps.operationId(), boundary }
      pending.set(key, entry)
    }
    if (entry.inFlight) return entry.inFlight
    const current = entry
    const request = async () => {
      current.receipt ??= await deps.hide(chatId, current.operationId)
      if (boundary.aborted) return
      await deps.confirm(accountId, current.receipt)
      if (pending.get(key) === current) pending.delete(key)
    }
    current.inFlight = request().finally(() => { current.inFlight = undefined })
    return current.inFlight
  }
}
