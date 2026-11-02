import { useSyncExternalStore } from 'react'
import { UI_EVENTS } from './uiEvents'

export type OwnedAgentResourceHost = { ownerId: string; chatId: string; projectId: string; sessionId: string }
const KEY = '__GUGU_OWNED_AGENT_RESOURCES__'
const CHANGED = 'gugu:owned-agent-resources'
export const OWNED_AGENT_RESOURCE_HOST_REQUEST = 'gugu:owned-agent-resource-host-request'
const EMPTY: readonly OwnedAgentResourceHost[] = []
const host = () => window as unknown as Record<string, readonly OwnedAgentResourceHost[]>
const read = () => host()[KEY] ?? EMPTY

/** The native conversation is open; its DM only supplies file authorization and App context. */
export function hostOwnedAgentResources(ownerId: string, chatId: string, target: { projectId: string; sessionId: string }): void {
  const existing = read().find(one => one.chatId === chatId && one.ownerId === ownerId)
  if (!existing || existing.projectId !== target.projectId || existing.sessionId !== target.sessionId) {
    host()[KEY] = [...read().filter(one => one.chatId !== chatId || one.ownerId !== ownerId), { ownerId, chatId, ...target }]
    window.dispatchEvent(new Event(CHANGED))
  }
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId } }))
}

export function clearOwnedAgentResources(ownerId: string): void {
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
