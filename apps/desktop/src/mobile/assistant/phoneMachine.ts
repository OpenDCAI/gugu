import { AssistantPanelError } from '@gugu/core/cloud/assistantPanel'
import { useCloudAssistantFiles } from '@/components/assistant/assistant-panel-files'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'

export type PhoneReadiness = 'ready' | 'asleep' | 'waking' | 'unreachable'
export type PhoneMachineState = { state: 'opening' } | { state: 'ready'; machine: AssistantMachine }
  | { state: 'error'; error: unknown; retry: () => void }

/** The panel uses account data; absent ownership/routing is a read failure. */
export function usePhoneMachine(homeDeviceId: string | null, assistantId: string, chatId: string): PhoneMachineState {
  const machine = useCloudAssistantFiles(assistantId,chatId,homeDeviceId)
  return machine ? { state: 'ready',machine } : { state: 'error',error: new AssistantPanelError(homeDeviceId ? 'missing-identity' : 'missing-home','PANEL_IDENTITY_UNAVAILABLE'),retry: () => {} }
}
