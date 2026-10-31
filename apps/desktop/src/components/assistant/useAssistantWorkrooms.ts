import { useEffect, useState } from 'react'
import type { AssistantShellSnapshot } from '../../lib/assistantShellBridge'
import { assistantWorkrooms, type AssistantWorkrooms } from '../../lib/assistantChatList'
import { rendererLogger } from '../../lib/log'
import { platform } from '../../platform'
import { useAuth } from '../../store/auth'
import { onMachineEvent, rpcOn } from '../../session/renderer/lib/ipc'
import { machineRpc } from '../../mobile/agent-watch/sessionpage-rpc'
import { projectGroupBindingChangedChannel } from '../../session/shared/core/projects/projectEvents'
import { sessionCreatedChannel } from '../../session/shared/core/sessions/sessionEvents'

const log = rendererLogger('assistant/workrooms')

/** Read the owning host's actual session identities and project bindings. Never infer ownership from a group name. */
export function useAssistantWorkrooms(shell: AssistantShellSnapshot | null, membershipKey: string): AssistantWorkrooms | null {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  const assistantId = shell?.assistantState === 'found' ? shell.assistant?.id ?? null : null
  const home = shell?.home
  const deviceId = home?.deviceId ?? null
  const local = home?.kind === 'computer' && home.thisDevice
  const scope = ownerId && assistantId && deviceId ? `${ownerId}:${assistantId}:${deviceId}:${local}` : null
  const [read, setRead] = useState<{ scope: string; rooms: AssistantWorkrooms } | null>(null)
  useEffect(() => {
    if (!scope || !ownerId || !assistantId || !deviceId) return
    let cancelled = false
    let generation = 0
    const refresh = async () => {
      const turn = ++generation
      try {
        const rpc = platform.capabilities.agentRuntime ? rpcOn(local ? null : deviceId) : machineRpc(deviceId)
        const [listed, bound] = await Promise.all([rpc.sessionTimeline.sessionsList(), rpc.projects.listProjectGroupBindings()])
        if (!bound.success) throw new Error(JSON.stringify(bound.error))
        const rooms = assistantWorkrooms(assistantId, ownerId, listed.sessions, bound.data)
        if (!cancelled && turn === generation) setRead({ scope, rooms })
      } catch (error) {
        // Keep already verified ownership for this scope; without a reading no group is hidden.
        log.warn({ error: String(error) }, 'could not read assistant workroom ownership')
      }
    }
    void refresh()
    // 推送在助理所在的那台机器上订(本机 = null);手机上没有会话页宿主线,只读不订。
    const machine = local ? null : deviceId
    const listen = platform.capabilities.agentRuntime
    const offBindings = listen ? onMachineEvent(machine, projectGroupBindingChangedChannel, () => { void refresh() }) : () => {}
    const offSessions = listen ? onMachineEvent(machine, sessionCreatedChannel, () => { void refresh() }) : () => {}
    return () => { cancelled = true; offBindings(); offSessions() }
  }, [scope, ownerId, assistantId, deviceId, local, membershipKey])
  return read?.scope === scope ? read.rooms : null
}
