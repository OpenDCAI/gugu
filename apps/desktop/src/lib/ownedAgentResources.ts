import type { PanelItem } from '@/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { useSyncExternalStore } from 'react'
import { UI_EVENTS } from './uiEvents'

export type OwnedAgentResourceHost = { ownerId: string; chatId: string; projectId: string; sessionId: string }
const KEY = '__GUGU_OWNED_AGENT_RESOURCES__'
const CHANGED = 'gugu:owned-agent-resources'
export const OWNED_AGENT_RESOURCE_HOST_REQUEST = 'gugu:owned-agent-resource-host-request'
const EMPTY: readonly OwnedAgentResourceHost[] = []
const WAITING = '__GUGU_OWNED_AGENT_RESOURCES_WAITING__'
const pending = (): Set<string> => {
  const state = window as unknown as Record<string, Set<string>>
  return state[WAITING] ??= new Set()
}
const requestKey = (ownerId: string, chatId: string) => `${ownerId}:${chatId}`
export function ownedAgentResourceHost(ownerId: string, chatId: string): OwnedAgentResourceHost | undefined {
  return read().find(one => one.ownerId === ownerId && one.chatId === chatId)
}
export function suspendOwnedAgentResources(ownerId: string, chatId: string): void { pending().add(requestKey(ownerId, chatId)) }
export function resumeOwnedAgentResources(ownerId: string, chatId: string): void { pending().delete(requestKey(ownerId, chatId)) }
export function canTakeOwnedAgentResource(ownerId: string, chatId: string): boolean {
  return Boolean(ownedAgentResourceHost(ownerId, chatId)) && !pending().has(requestKey(ownerId, chatId))
}
const host = () => window as unknown as Record<string, readonly OwnedAgentResourceHost[]>
const read = () => host()[KEY] ?? EMPTY

/** The native conversation is open; its DM only supplies file authorization and App context. */
export function hostOwnedAgentResources(ownerId: string, chatId: string, target: { projectId: string; sessionId: string }): void {
  pending().delete(requestKey(ownerId, chatId))
  const existing = read().find(one => one.chatId === chatId && one.ownerId === ownerId)
  if (!existing || existing.projectId !== target.projectId || existing.sessionId !== target.sessionId) {
    host()[KEY] = [...read().filter(one => one.chatId !== chatId || one.ownerId !== ownerId), { ownerId, chatId, ...target }]
    window.dispatchEvent(new Event(CHANGED))
  }
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
}

export function clearOwnedAgentResources(ownerId: string): void {
  for (const key of pending()) if (key.startsWith(`${ownerId}:`)) pending().delete(key)
  host()[KEY] = read().filter(one => one.ownerId !== ownerId)
  window.dispatchEvent(new Event(CHANGED))
}

export function useOwnedAgentResourceHosts(): readonly OwnedAgentResourceHost[] {
  return useSyncExternalStore(listener => {
    window.addEventListener(CHANGED, listener)
    return () => window.removeEventListener(CHANGED, listener)
  }, read, () => EMPTY)
}

/** A restored native resource tab asks the signed-in shell for its original chat host. */
export function requestOwnedAgentResourceHost(chatId: string, target: { projectId: string; sessionId: string }): void {
  window.dispatchEvent(new CustomEvent(OWNED_AGENT_RESOURCE_HOST_REQUEST, { detail: { chatId, ...target } }))
}

// As with shell slots, both renderer roots use the shell's one resource registry.
type ResourceTabs = {
  read(chatId: string, tabId: string): { item: PanelItem } | null
  open(chatId: string, item: PanelItem): string | undefined
  close(chatId: string, tabId: string): void
}
const TABS = '__GUGU_OWNED_AGENT_RESOURCE_TABS__'
export function installOwnedAgentResourceTabs(tabs: ResourceTabs): void {
  (window as unknown as Record<string, unknown>)[TABS] = tabs
}
export function ownedAgentResourceTabs(): ResourceTabs {
  const tabs = (window as unknown as Record<string, ResourceTabs>)[TABS]
  if (!tabs) throw new Error('The conversation resource host is unavailable')
  return tabs
}

/** Native resource slots never compete with a restored legacy chat's panel slots. */
export const ownedAgentResourceSlotKey = (chatId: string, tabId: string): string => `owned-agent-resource:${chatId}/${tabId}`
