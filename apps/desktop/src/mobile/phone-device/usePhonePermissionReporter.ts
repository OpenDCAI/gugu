import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client'
import { useMyAssistant } from '@/lib/myAssistant'
import { machineRpc } from '../agent-watch/sessionpage-rpc'
import { thisPhoneDeviceId } from './phoneDeviceSettings'

/** Report committed phone choices through the same assistant App channel in settings and setup. */
export function usePhonePermissionReporter(ownerId: string | null) {
  const assistant = useMyAssistant(ownerId, undefined)
  return (action: string, enabled: boolean, group?: string) => {
    if (!ownerId || (!assistant.agentId && !assistant.loading && !assistant.error)) return
    const deviceId = thisPhoneDeviceId(ownerId) ?? undefined
    void reportAssistantAppChange(assistant.provisionDeviceId ? { rpc: machineRpc(assistant.provisionDeviceId) } : null,
      assistant.agentId ?? undefined, { resource: 'devices', operation: 'edited', section: 'permissions',
        id: deviceId ?? 'phone-permission-settings', deviceId, after: { action, enabled, ...(group ? { group } : {}) } }, ownerId)
  }
}
