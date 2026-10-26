import type { Device } from '@gugu/core/shared/types/chat'
import { platform } from '@/platform'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { machineRpc } from '@/mobile/agent-watch/sessionpage-rpc'

/** 问一台机器上的项目:手机经那台机器的会话页管道;窄窗口的桌面问自己走本机,问别的机器同电脑那一条(同 useAssistantWorkrooms)。 */
export function projectRpcOn(device: Pick<Device, 'device_id' | 'is_current_device'>) {
  return platform.capabilities.agentRuntime ? rpcOn(device.is_current_device ? null : device.device_id) : machineRpc(device.device_id)
}
