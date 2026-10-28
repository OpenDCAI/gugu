import { useEffect, useMemo } from 'react'
import type { AssistantMachine } from '@/session/renderer/features/assistant/assistant-machine-core'
import { requireAssistantPanelBridge, useAssistantPanelAccountId } from '@/lib/assistantPanelBridge'
export { ASSISTANT_PANEL_CHANGED } from './assistant-panel-events'

/** Both React roots use the shell-owned cloud operations; no native project is acquired. */
export function useCloudAssistantFiles(assistantId: string | null, chatId: string | null, deviceId: string | null): AssistantMachine | undefined {
  const ownerId = useAssistantPanelAccountId()
  const machine = useMemo(() => {
    if (!assistantId || !chatId || !deviceId || !ownerId) return undefined
    const panel = requireAssistantPanelBridge().files({ ownerId,assistantId,chatId,deviceId })
    return { deviceId,target: deviceId,projectId: `panel:${ownerId}:${assistantId}`,workspaceId: chatId,home: '',paths: panel.paths,rpc: null,panel } satisfies AssistantMachine
  },[assistantId,chatId,deviceId,ownerId])
  useEffect(() => {
    if (!machine?.panel || !ownerId) return
    return requireAssistantPanelBridge().subscribeChanges(ownerId,() => machine.panel.invalidate())
  },[machine,ownerId])
  return machine
}
