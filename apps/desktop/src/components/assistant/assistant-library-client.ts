import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import { platform } from '../../platform'
import { rpcOn } from '../../session/renderer/lib/ipc'
import { readCachedDevices } from '../../store/devicesCache'

export const libraryHost = (machine: Pick<AssistantMachine, 'rpc'> | null | undefined) => platform.capabilities.agentRuntime ? rpcOn(null).app : machine?.rpc?.app
export const libraryDeviceId = (machine: AssistantMachine | null | undefined) => platform.capabilities.agentRuntime
  ? readCachedDevices().find(device => device.is_current_device)?.device_id : machine?.deviceId
