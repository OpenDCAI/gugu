import { useSyncExternalStore } from 'react'

/**
 * #7199 手机壳认出的个人助理(usePhoneAssistant 写,只一个写者):「任务」tab 照桌面侧栏那样藏起它自己的会话、
 * 给它派的那些标「由它发起」。桌面侧栏经助理桥拿同一个 id(sidebar-store)。
 */
export type PhoneAssistantIdentity = { id: string; name: string } | null

let current: PhoneAssistantIdentity = null
const listeners = new Set<() => void>()

export function publishPhoneAssistant(next: PhoneAssistantIdentity): void {
  if (current?.id === next?.id && current?.name === next?.name) return
  current = next
  for (const listener of listeners) listener()
}

export function readPhoneAssistantIdentity(): PhoneAssistantIdentity {
  return current
}

export function subscribePhoneAssistantIdentity(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function usePhoneAssistantIdentity(): PhoneAssistantIdentity {
  return useSyncExternalStore(subscribePhoneAssistantIdentity, readPhoneAssistantIdentity, () => null)
}
