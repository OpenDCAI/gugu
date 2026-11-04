import type { Device } from '@gugu/core/shared/types/chat'
import { serverProtocolTooOld, REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'

export type AssistantServerTargetReason = 'unsupported_platform' | 'unsupported_arch' | 'target_offline' | 'server_update_required'
export type AssistantServerTarget = { deviceId: string; label: string; selectable: boolean; reason: AssistantServerTargetReason | null }

/** Input is the signed-in owner's device directory, never a machine/SSH inventory. */
export function assistantServerTargets(devices: readonly Device[]): AssistantServerTarget[] {
  return devices.filter(row => row.capabilities.host_kind === 'server' && !row.capabilities.assistant_home && !row.cloud_computer)
    .map(row => {
      const reason: AssistantServerTargetReason | null = row.platform !== 'linux' ? 'unsupported_platform'
        : row.capabilities.arch !== 'x64' && row.capabilities.arch !== 'arm64' ? 'unsupported_arch'
          : !row.is_online ? 'target_offline'
            : row.capabilities.assistant_home_setup !== 1 || serverProtocolTooOld(row.capabilities.remote_protocol, { unknownIsTooOld: true })
              || (row.capabilities.min_client_protocol ?? 0) > REMOTE_PROTOCOL_VERSION ? 'server_update_required' : null
      return { deviceId: row.device_id, label: row.label, selectable: reason === null, reason }
    })
}
