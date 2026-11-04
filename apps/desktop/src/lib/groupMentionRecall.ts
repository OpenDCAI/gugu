import { useSyncExternalStore } from 'react'
import { browserStorage } from '@renderer/features/remote-hosts/remote-recent-folders'

const key = (accountId: string, chatId: string) => `gugu:group-mention:${encodeURIComponent(accountId)}/${encodeURIComponent(chatId)}`
const listeners = new Set<() => void>()
function read(accountId: string | null | undefined, chatId: string | null | undefined): string | null {
  if (!accountId || !chatId) return null
  try {
    const id = browserStorage()?.getItem(key(accountId, chatId))
    return id && id.length <= 128 ? id : null
  } catch { return null }
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => { listeners.delete(listener); window.removeEventListener('storage', listener) }
}
export function useGroupMentionRecall(accountId: string | null | undefined, chatId: string | null | undefined): string | null {
  return useSyncExternalStore(subscribe, () => read(accountId, chatId))
}
/** Advisory, account-local UI preference; a storage failure must never roll back a delivered message. */
export function rememberGroupMention(accountId: string, chatId: string, id: string | null): void {
  try {
    if (id) browserStorage()?.setItem(key(accountId, chatId), id)
    else browserStorage()?.removeItem(key(accountId, chatId))
  } catch { /* Unavailable local preferences do not affect message delivery. */ }
  for (const listener of listeners) listener()
}
