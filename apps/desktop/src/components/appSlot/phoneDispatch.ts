import type { AppMessageAction, AppSpawnAction, UnreachedMachine } from '@gugu/session-core/session-record/contract'
import { agentReport, agentViewOf, type ListedSession } from '../../session/shared/extensions/agent-view'
import type { ExtensionAgentView } from '../../session/shared/extensions/bridge-protocol'
import { rendererLogger } from '../../lib/log'
import { isAssistantHome } from '../../lib/assistantHome'
import { readCachedDevices } from '../../store/devicesCache'
import { appDeviceId } from '../../session/shared/extensions/machine-call'
import { directoryRows, liveDeviceSessions, rowOpens } from '../../session/shared/remote-sessions/session-directory'
import { visibleMachines, workspaceDevices } from '../../mobile/agent-watch/machine-list'
import { composeTaskDraft } from '@/lib/composeDraft'
import { AppSendError, type AppDispatchPlatform, type DispatchAgent } from '../../session/shared/extensions/app-send-core'
import { grantedReach, type ExtensionCapability } from '../../session/shared/extensions/manifest'
import { phoneAppCaller } from './phoneProgramCall'

/** Read the phone's existing directory; never open another set of machine subscriptions for an App. */
export function phoneDispatch(app: { extensionId: string; extensionName: string }, capabilities: readonly ExtensionCapability[], context: { deviceId?: string; chatId?: string | null; agents?: readonly string[] }) {
  const devices = workspaceDevices(readCachedDevices())
  const live = liveDeviceSessions()
  const rows = directoryRows(devices, live)
  const ready = (deviceId: string) => {
    const device = readCachedDevices().find((one) => one.device_id === deviceId)
    const listed = liveDeviceSessions()[deviceId]
    return !!device?.is_online && !!listed && !listed.cached && !listed.loading && !listed.error
  }
  const local = rows.filter((row) => ready(row.deviceId) && rowOpens(row.session) && row.session.agent)
    .map((row) => `user:${row.session.agent!.userId}`)
  const computers = visibleMachines(devices, (device) => isAssistantHome(device, null)).filter((device) => device.is_online)
    .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
  const inGroup = (deviceId: string) => rows.some((row) => row.deviceId === deviceId &&
    ((context.chatId && row.session.chatId === context.chatId) || (row.session.agent && context.agents?.includes(`user:${row.session.agent.userId}`))))
  const spawnOn = (computers.find((device) => device.device_id === context.deviceId) ?? computers.find((device) => inGroup(device.device_id)) ?? computers[0])?.device_id ?? null
  // Read the same list as the task tab, afresh for an App call: a just-started agent may precede its subscription push.
  const read = async () => {
    const { fetchSessionsList } = await import('../../mobile/agent-watch/sessionpage-rpc')
    const computers = workspaceDevices(readCachedDevices())
    const answers = await Promise.allSettled(computers.map(async (device) => {
      if (!device.is_online) throw new Error(`${device.label} is offline`)
      const list = await fetchSessionsList(device.device_id)
      if (list.sessions.some((session) => session.agent === undefined)) throw new Error(`${device.label} is too old to list its agents`)
      return list.sessions.map((session): ListedSession & { deviceId: string } => ({ session, deviceId: device.device_id, deviceLabel: device.label }))
    }))
    const rows: Array<ListedSession & { deviceId: string }> = []
    const unread: string[] = []
    const unreached: UnreachedMachine[] = []
    answers.forEach((answer, index) => {
      if (answer.status === 'fulfilled') rows.push(...answer.value)
      else {
        const device = computers[index]!
        unread.push(device.label)
        unreached.push({ deviceId: device.device_id, label: device.label, detail: answer.reason instanceof Error ? answer.reason.message : String(answer.reason) })
      }
    })
    return { rows, unread, unreached }
  }
  const locate = async (agent: string) => {
    const { rows, unread } = await read()
    const row = rows.find((one) => `user:${one.session.agent?.userId}` === agent)
    if (row) return row
    throw new AppSendError(unread.length ? 'failed' : 'not-found', `${agent} is not in your computers' current agent lists${unread.length ? ` (not read: ${unread.join(', ')})` : ''}`)
  }
  function listAgents(): Promise<ExtensionAgentView[]>
  function listAgents(report: true): Promise<ReturnType<typeof agentReport>>
  async function listAgents(report?: true) {
    const { rows, unread, unreached } = await read()
    if (unread.length) rendererLogger('app-slot/phone-dispatch').warn({ extensionId: app.extensionId, machines: unread }, 'listAgents: computers were not read')
    const agents = viewsOf(rows, app.extensionId, capabilities)
    if (!report) return agents
    const all = grantedReach(capabilities, 'agents:read') === 'all-machines'
    return agentReport(agents, all ? unreached : [], all ? readCachedDevices().map(({ device_id, label, is_online }) => ({ deviceId: device_id, label, online: is_online, thisMachine: false })) : [])
  }
  const request = async <A extends AppMessageAction | AppSpawnAction>(deviceId: string, action: A) => {
    const { appCallOn } = await import('../../mobile/agent-watch/sessionpage-rpc')
    return appCallOn(deviceId, phoneAppCaller(app), action)
  }
  const agents: NonNullable<AppDispatchPlatform['agents']> = {
    async draft(agent: DispatchAgent, text) {
      if (!text) throw new AppSendError('invalid', 'Nothing to compose: text is empty')
      const row = await locate(agent.agent)
      if (!rowOpens(row.session)) throw new AppSendError('not-found', `${agent.agent} has no task composer on this phone`)
      await composeTaskDraft(row, `${text}\n`, true)
      return agent.agent
    },
    async tell(agent, text, how) {
      const row = await locate(agent.agent)
      if (agent.named && grantedReach(capabilities, 'agents:control') !== 'all-machines' && row.session.spawnedByExtensionId !== app.extensionId) {
        throw new AppSendError('not-found', `${agent.agent} is not an agent this App started; agents:control:all-machines or the person's sheet pick reaches other agents`)
      }
      const receipt = await request(row.deviceId, { action: 'message', session_ids: [row.session.conversationId], text, ...how })
      return { agent: agent.agent, ...receipt }
    },
    async spawn(prompt, spawn, selectedDevice) {
      const { device, ...options } = spawn
      const deviceId = selectedDevice ?? (device !== undefined ? appDeviceId(device) : spawnOn)
      if (!deviceId || !visibleMachines(workspaceDevices(readCachedDevices()), (device) => isAssistantHome(device, null)).some((device) => device.device_id === deviceId && device.is_online)) throw new AppSendError('failed', 'No online computer is available to start this agent')
      const receipt = await request(deviceId, { action: 'spawn', prompt, spawn: options })
      return receipt.agentId
    },
  }
  return { agents, local, spawnOn, listAgents }
}

function viewsOf(rows: ListedSession[], extensionId: string, capabilities: readonly ExtensionCapability[]) {
  const visible = rows.filter(({ session }) => grantedReach(capabilities, 'agents:read') === 'all-machines' || session.spawnedByExtensionId === extensionId)
  const ids = new Map(visible.flatMap(({ session }) => session.agent ? [[session.conversationId, `user:${session.agent.userId}`] as const] : []))
  return visible.flatMap((row) => agentViewOf(row, ids, extensionId, null) ?? [])
}

/** Events observe the shell's existing directory, without opening another computer subscription. */
export function cachedPhoneAgents(extensionId: string, capabilities: readonly ExtensionCapability[]) {
  const devices = workspaceDevices(readCachedDevices())
  return viewsOf(directoryRows(devices, liveDeviceSessions()).map((row) => ({ ...row, deviceLabel: devices.find((device) => device.device_id === row.deviceId)?.label ?? null })), extensionId, capabilities)
}
