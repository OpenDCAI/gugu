import { useSyncExternalStore } from 'react'
import { AssistantPanelError, type AssistantPanelReceipt } from '@gugu/core/cloud/assistantPanel'
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles'
import type { AssistantAppChange } from '@/session/shared/extensions/assistant-app'

/** The shell owns authentication and cloud effects. Session-page bundles receive
 * operations and public account identity, never credentials or an AuthContext. */
export interface AssistantPanelBridge {
  accountId(): string | null
  subscribeAccount(listener: () => void): () => void
  files(input: { ownerId: string; assistantId: string; chatId: string; deviceId: string }): AssistantPanelFiles
  subscribeChanges(ownerId: string, listener: () => void): () => void
  personalAssistant(ownerId: string): Promise<string | null>
  privateChat(ownerId: string, assistantId: string): Promise<string>
  queueNotice(change: AssistantAppChange, assistantId: string | undefined, ownerId: string | null): Promise<AssistantPanelReceipt | null>
}
const KEY = '__GUGU_ASSISTANT_PANEL__' as const
export type AssistantPanelWindow = Window & { [KEY]?: AssistantPanelBridge }
export function readAssistantPanelBridge(): AssistantPanelBridge | undefined {
  return typeof window === 'undefined' ? undefined : (window as AssistantPanelWindow)[KEY]
}
export function requireAssistantPanelBridge(): AssistantPanelBridge {
  const bridge = readAssistantPanelBridge()
  if (!bridge) throw new AssistantPanelError('missing-identity','PANEL_SHELL_UNAVAILABLE')
  return bridge
}
export const assistantPanelAccountId = () => readAssistantPanelBridge()?.accountId() ?? null
const subscribe = (listener: () => void) => readAssistantPanelBridge()?.subscribeAccount(listener) ?? (() => {})
export function useAssistantPanelAccountId() { return useSyncExternalStore(subscribe,assistantPanelAccountId,() => null) }
