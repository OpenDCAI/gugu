/**
 * agent 的 session_* 跨机器(owner 2026-09-30 拍板)。
 *
 * 发起方:机器清单是这个账号的 `gugu_devices`;`device` 参数把动作交给那台机器;本机没有的 `session:` 去问在线的
 * 机器,身份地址查云端身份的 `device_id`。请求一律是那台机器会话页路由表上的一问一答(`taskhost.call`):动作走
 * `agentSession.<动作>`(对端用与本机工具同一份实现执行),列会话、归档走界面同一个 `sessionTimeline.*`。
 * 离线、不在名下、够不着、太旧都在发出之前说清;发出去没回音就说「那边可能已经做了」,❌ 排队、❌ 换机器。
 */
import type { Device } from '@gugu/core/shared/types/chat'
import { deviceMachines } from '@gugu/core/shared/deviceMachines'
import { isAgentHostDevice } from '@gugu/core/cloud/devices'
import { cloudComputerPresence, type CloudComputerSnapshot } from '@gugu/core/cloud/cloudComputer'
import type { DeviceRpcResponse } from '@gugu/core/cloud/deviceRpcProtocol'
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '@shared/extensions/host-actions'
import {
  type AgentSessionAction,
  type AgentSessionActionName,
  type AppMessageAction,
  type AppSpawnAction,
  type AppCallAction,
  appCallWaitMs,
  type AppMessageReceipt,
  type RemoteAppCaller,
  type RemoteCaller,
  type RemoteSessionCaller,
  type SessionpageSessionsListResult,
} from '@gugu/session-core/session-record/contract'
import { SESSION_HOST_RPC } from '@shared/lib/ipc/session-host-device-frames'
import { FILE_PATCH_PROTOCOL, protocol14FileChanges } from '@gugu/session-core/session-record/contract'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { dispatchCallOf } from '@shared/extensions/app-dispatch-core'
import type { OtherMachines } from './session/main/core/sessions/session-family'
import { DeviceRpcChannelError, DeviceRpcTimeoutError, type DeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import type { UnifiedRecipientResult, UnifiedSessionMessageDeps } from './unified-session-message'

/** 跨机器这一格的失败,带机器可读的码(与 session_message 逐收件人结果里的 `error.code` 同一套)。 */
export class CrossMachineError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CrossMachineError'
  }
}

type Action = { action: string } & Record<string, unknown>

/** 等对端多久:message 可能要先唤醒一条停着的会话;spawn / list_models 可能要探一次模型目录。 */
/** What an App's page asks of another machine: its answer is the page's to read, with no agent tool to check by. */
const APP_ACTIONS = new Set(['app_call'])
/** 同一台机器的会话列表多久内复用(一次操作里几处都要它:App 刷新、按 Agent ID 投递、改父子)。 */
const SESSIONS_LIST_REUSE_MS = 5_000

export function remoteActionTimeoutMs(action: { action: string; force?: unknown }): number {
  switch (action.action) {
    case 'locate':
      return 10_000
    case 'message':
      return 180_000
    case 'spawn':
      return 90_000
    // A page's call there: a program's is the MCP client's own request bound (60 s) on that machine, and the way back.
    case 'app_call':
      return appCallWaitMs({ method: String((action as { method?: unknown }).method) })
    // app_install { device }:那台机器下载、校验,再等人点头(人的那口钟)—— 那口钟落定之前它总会回话。
    case 'app_manage':
    case 'app_install':
      return INSTALL_CONSENT_HUMAN_WINDOW_MS + 30_000
    case 'list_models':
      return action.force === true ? 120_000 : 60_000
    default:
      return 30_000
  }
}

function ago(iso: string, now: number): string {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'at an unknown time'
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 90) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** 别的机器回来的行标上它在哪台机器(`device_id` 在 MCP 边界编成 `device:`)。 */
function onDevice(value: unknown, deviceId: string, label: string | null): unknown {
  if (Array.isArray(value)) return value.map((item) => onDevice(item, deviceId, label))
  if (!value || typeof value !== 'object') return value
  return { ...(value as Record<string, unknown>), device_id: deviceId, device_label: label }
}

export type CrossMachineDeps = {
  thisDeviceId(): Promise<string>
  /** 这个账号的机器,每次现读 —— 在线与否是库给的结论(#5912)。 */
  listDevices(): Promise<Device[]>
  /** 云端身份里本账号的 agent(别人的查不回来)。 */
  lookupAgents(input: { userIds: string[]; numbers: number[] }): Promise<Array<{
    userId: string
    guguNumber: number | null
    deviceId: string | null
  }>>
  requester: Pick<DeviceRpcRequester, 'call'>
  now?: () => number
  /** #7199 这个账号的云电脑此刻怎样(云电脑管家 /state);拿不到管家地址 = null。session_devices 据此标出哪台是它、睡没睡。 */
  cloudComputerState?(): Promise<CloudComputerSnapshot | null>
  /**
   * #7199 离线的那台要是这个账号的云电脑:叫醒它、等它上线(true);不是云电脑 = false。醒不来抛 CloudComputerWakeError。
   * 休眠中 ≠ 离线(规定草稿 cloud-computer),所以这一格在「离线就拒绝」之前问。
   */
  wakeCloudComputer?(deviceId: string, signal?: AbortSignal): Promise<boolean>
}

/** 对端答 `agentSession.*` 时用到的宿主能力。 */
export type AgentSessionHost = {
  peers(): Promise<unknown>
  /** 其余动作交给会话页编排(`runRemoteSessionAction`)。 */
  run(caller: RemoteSessionCaller, action: Action): Promise<unknown>
  /** 另一台机器上的 App 发来的消息:与本机 App 发消息同一个函数,信封写那个 App。 */
  app(caller: RemoteAppCaller, action: AppMessageAction): Promise<AppMessageReceipt>
  appSpawn(caller: RemoteAppCaller, action: AppSpawnAction): Promise<{ agentId: string }>
  /** 另一台机器上的 App 页面让这台机器做一个跟着会话机器的动词(它的数据目录、它的程序;页面在这台机器的一条会话里)。 */
  appCall(caller: RemoteAppCaller, action: AppCallAction): Promise<unknown>
}


export type CrossMachineSessions = ReturnType<typeof createCrossMachineSessions>

export function createCrossMachineSessions(deps: CrossMachineDeps) {
  const now = deps.now ?? (() => Date.now())
  /** 会话 → 它在哪台机器。会话不换机器,记下来就不过期;只放内存,重启后丢了就再问一次。 */
  const known = new Map<string, string>()

  const devices = async () => {
    const [thisDeviceId, rows] = await Promise.all([deps.thisDeviceId(), deps.listDevices()])
    return { thisDeviceId, rows }
  }
  const describe = (device: Device) => `"${device.label}" (device:${device.device_id})`
  const labelOf = async (deviceId: string) => (await deps.listDevices()).find((row) => row.device_id === deviceId)?.label ?? null
  const noTaskRuntime = (device: Device) => new CrossMachineError('device_no_task_runtime',
    `${describe(device)} 没有启用任务宿主。请主人在那台设备上开启任务宿主后重试；其他设备不能代调它的原生能力。`)

  /** 那台机器此刻能不能接 —— 不能就在发出去之前说清为什么。 */
  const reachable = async (deviceId: string, requireTaskRuntime = true, signal?: AbortSignal, allowWake = false): Promise<Device> => {
    signal?.throwIfAborted()
    const { thisDeviceId, rows } = await devices()
    if (deviceId === thisDeviceId) throw new CrossMachineError('SESSION_DEVICE_IS_THIS_MACHINE', `device:${deviceId} is this machine`)
    const device = rows.find((row) => row.device_id === deviceId)
    if (!device) {
      throw new CrossMachineError('SESSION_DEVICE_UNKNOWN', `device:${deviceId} is not one of this account's machines — session_devices lists them`)
    }
    if (requireTaskRuntime && !isAgentHostDevice(device)) throw noTaskRuntime(device)
    const cloud = await deps.cloudComputerState?.().catch(() => null)
    const pausedCloud = cloud?.deviceId === deviceId && ['asleep', 'waking', 'error', 'provisioning'].includes(cloud.state)
    if (!device.is_online || pausedCloud) {
      if (!allowWake) throw new CrossMachineError('SESSION_DEVICE_OFFLINE', `${describe(device)} is offline or paused; no wake was requested`)
      // #7199 睡着的云电脑:先叫醒,醒了照常发出去;醒不来就说是哪台、为什么。
      let woke = false
      try {
        woke = (await (signal ? deps.wakeCloudComputer?.(deviceId, signal) : deps.wakeCloudComputer?.(deviceId))) ?? false
        signal?.throwIfAborted()
      } catch (error) {
        if (signal?.aborted) throw error
        throw new CrossMachineError(
          'SESSION_DEVICE_WAKE_FAILED',
          `${describe(device)} is your cloud computer and could not be woken (${error instanceof Error ? error.message : String(error)}); nothing was sent there`,
        )
      }
      if (woke) {
        const awake = (await deps.listDevices()).find((row) => row.device_id === deviceId)
        if (awake?.is_online) return awake
      }
      if (pausedCloud) throw new CrossMachineError('SESSION_DEVICE_WAKE_FAILED', `${describe(device)} has not resumed; nothing was sent there`)
      throw new CrossMachineError(
        'SESSION_DEVICE_OFFLINE',
        `${describe(device)} is offline (last seen ${ago(device.last_seen_at, now())}); nothing was sent there`,
      )
    }
    return device
  }

  /** 所有跨机器的请求只走这一处(那台机器路由表上的一问一答):出错时说清是哪台、为什么。`what` 是要那台机器做的事。 */
  const ask = async (device: Device, channel: string, args: unknown[], timeoutMs: number, what: string, signal?: AbortSignal): Promise<unknown> => {
    const deviceId = device.device_id
    const outdated = () => new CrossMachineError(
      'SESSION_DEVICE_OUTDATED',
      `咕咕 on ${describe(device)} is too old for cross-machine sessions; it updates itself when idle. Nothing was sent there`,
    )
    let response: DeviceRpcResponse<unknown>
    try {
      response = await deps.requester.call(deviceId, SESSION_HOST_RPC.call, { channel, args, protocol: REMOTE_PROTOCOL_VERSION }, { timeoutMs, signal })
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof DeviceRpcTimeoutError) {
        throw new CrossMachineError(
          'SESSION_DEVICE_NO_ANSWER',
          `${describe(device)} did not answer within ${Math.round(timeoutMs / 1000)} s — the ${what} may or may not have happened there${APP_ACTIONS.has(what) ? '' : '; check with session_get / session_children before repeating it'}`,
        )
      }
      if (error instanceof DeviceRpcChannelError && error.reason === 'signInRequired') {
        throw new CrossMachineError(
          'SESSION_DEVICE_SIGN_IN_REQUIRED',
          `${describe(device)} is reached over SSH and needs a person to sign in once (Settings → Devices); nothing was sent there`,
        )
      }
      if (error instanceof DeviceRpcChannelError && error.reason === 'outdated') throw outdated()
      if (error instanceof DeviceRpcChannelError) {
        throw new CrossMachineError('SESSION_DEVICE_UNREACHABLE', `${describe(device)} is online but could not be reached (${error.message}); nothing was sent there`)
      }
      throw error
    }
    // 协议 5 及更早没有 `taskhost.call`;协议 6 有它,但路由表上还没有这个方法(那台机器的路由表原样说
    // 「No handler registered for '<方法>'」)。两种都是那台机器太旧。
    if (response.error?.code === 'unknown_method' || response.error?.message.startsWith('No handler registered for ')) throw outdated()
    // 对端的工具错误原样带回(那台机器上同一个工具会说的那句话),前面点名是哪台机器。
    if (response.error) throw new CrossMachineError(response.error.code || 'SESSION_REMOTE_ERROR', `on ${describe(device)}: ${response.error.message}`)
    const result = response.result as { value?: unknown; protocol?: number } | undefined
    // A host before protocol 15 does not say its protocol here (protocol14FileChanges, delete on next bump).
    return protocol14FileChanges(result?.value, result?.protocol ?? FILE_PATCH_PROTOCOL - 1, 'from-peer')
  }

  /**
   * 一台机器的会话列表(界面那份,`sessionTimeline.sessionsList`),跨机器读会话的都从这里拿:同一台 5 秒内复用同一次结果,
   * 正在问的合成一个,失败不留。`fresh` 不用记下的、问回来的照样记下。`listsAgents` = 每行都带 agent(协议 7 起);
   * 不带的老宿主认不出它的 agent。
   */
  const listed = new Map<string, { settledAt: number | null; value: Promise<{ sessions: SessionpageSessionsListResult['sessions']; listsAgents: boolean }> }>()
  const sessionsOn = (device: Device, options: { fresh?: boolean } = {}) => {
    const kept = listed.get(device.device_id)
    if (kept && !options.fresh && (kept.settledAt === null || now() - kept.settledAt < SESSIONS_LIST_REUSE_MS)) return kept.value
    const value = (ask(device, 'sessionTimeline.sessionsList', [], 30_000, 'listing') as Promise<SessionpageSessionsListResult>)
      .then((result) => ({ sessions: result?.sessions ?? [], listsAgents: (result?.sessions ?? []).every((session) => session.agent !== undefined) }))
    const entry = { settledAt: null as number | null, value }
    listed.set(device.device_id, entry)
    value.then(() => { entry.settledAt = now() }, () => { if (listed.get(device.device_id) === entry) listed.delete(device.device_id) })
    return value
  }
  /** 往那台机器发了别的(归档、改父子、派、投递、App 的动作):它的列表可能变了,记下的那份作废 —— 发之前、回来后各一次。 */
  const request: typeof ask = async (device, ...rest) => {
    listed.delete(device.device_id)
    try {
      return await ask(device, ...rest)
    } finally {
      listed.delete(device.device_id)
    }
  }

  const call = async (deviceId: string, caller: RemoteCaller, action: Action, signal?: AbortSignal): Promise<unknown> => {
    const sessionCaller = 'kind' in caller ? null : caller
    // Older hosts understand default/spawner and root through nest. The new parent field stays authoritative.
    const wire = sessionCaller && action.action === 'spawn' ? { ...action, nest: action.parent_session_id !== null } : action
    const result = await request(await reachable(deviceId, !!sessionCaller, signal, action.action === 'message' || action.action === 'spawn'), action.action === 'spawn' && action.assistant_work ? 'assistantWork.prepare' : `agentSession.${action.action}`, [caller, wire], remoteActionTimeoutMs(action), action.action, signal)
    if (sessionCaller && action.action === 'spawn' && typeof action.parent_session_id === 'string'
      && action.parent_session_id !== sessionCaller.sessionId) {
      const created = result as { session_id: string; parent_session_id?: string | null }
      if (created?.parent_session_id !== action.parent_session_id) {
        throw new CrossMachineError('SESSION_PARENT_UNSUPPORTED',
          `${created?.session_id ? encodeTypedId('session', created.session_id) : 'The session'} was created, but that device's version does not support putting it under the given parent; update that device, or move it with session_set_parent. Do not spawn it again`)
      }
    }
    return result
  }

  const assertFileHandoffSupported = async (deviceIds: string[]) => {
    for (const id of new Set(deviceIds)) {
      const device = await reachable(id, true, undefined, true)
      const protocol = device.capabilities.remote_protocol
      if (typeof protocol !== 'number' || protocol < 11) throw new CrossMachineError(
        'SESSION_DEVICE_OUTDATED', `Update 咕咕 on ${describe(device)} before sending session files; nothing was uploaded or sent there`,
      )
    }
  }

  /** 本机库里没有的 `session:` id 各在哪台机器:先查记下的,再并发问在线的机器。 */
  const locateSessions = async (ids: string[], caller: RemoteSessionCaller, signal?: AbortSignal) => {
    const found = new Map(ids.flatMap((id) => (known.has(id) ? [[id, known.get(id)!] as const] : [])))
    const missing = ids.filter((id) => !found.has(id))
    const { thisDeviceId, rows } = await devices()
    const others = rows.filter((row) => row.device_id !== thisDeviceId)
    const unasked = others.filter((row) => !row.is_online || !isAgentHostDevice(row))
    if (!missing.length) return { found, unasked: [] as Device[] }
    await Promise.all(others.filter((row) => row.is_online && isAgentHostDevice(row)).map(async (device) => {
      try {
        const result = await call(device.device_id, caller, { action: 'locate', session_ids: missing }, signal) as { session_ids?: unknown }
        for (const id of Array.isArray(result?.session_ids) ? result.session_ids : []) {
          if (typeof id === 'string' && missing.includes(id)) found.set(id, device.device_id)
        }
      } catch (error) {
        if (signal?.aborted) throw error
        unasked.push(device)
      }
    }))
    for (const [id, deviceId] of found) known.set(id, deviceId)
    return { found, unasked }
  }

  const notFoundMessage = (ids: string[], unasked: Device[]) => {
    const list = ids.map((id) => `session:${id}`).join(', ')
    const tail = unasked.length
      ? ` — could not check: ${unasked.map((device) => !isAgentHostDevice(device) ? noTaskRuntime(device).message : `${describe(device)} (${device.is_online ? 'no answer' : `offline, last seen ${ago(device.last_seen_at, now())}`})`).join(', ')}`
      : ''
    return `${list} is not a session on this machine or on any of this account's online machines${tail}. session_peers (with device for another machine) lists what is addressable; nothing was sent`
  }

  /** 一条不在本机库里的会话在哪台机器上;哪儿都没有就当场说。 */
  const deviceOfSession = async (sessionId: string, caller: RemoteSessionCaller, signal?: AbortSignal) => {
    const { found, unasked } = await locateSessions([sessionId], caller, signal)
    const deviceId = found.get(sessionId)
    if (!deviceId) throw new Error(notFoundMessage([sessionId], unasked))
    return deviceId
  }

  /** 指名一条不在本机库里的会话的动作(get / stop / archive / set_parent):交给它所在的机器。 */
  const runOnSession = async (sessionId: string, caller: RemoteSessionCaller, action: Action, signal?: AbortSignal) => {
    const deviceId = await deviceOfSession(sessionId, caller, signal)
    try {
      return onDevice(await call(deviceId, caller, action, signal), deviceId, await labelOf(deviceId))
    } catch (error) {
      if (error instanceof CrossMachineError && error.message.includes('session not found on this machine')) known.delete(sessionId)
      throw error
    }
  }

  /** `device` 参数:还没有地址的动作在那台机器上做。起出来的 child、名录里的会话都记下它们在哪。 */
  const runOnDevice = async (deviceId: string, caller: RemoteSessionCaller, action: Action, signal?: AbortSignal) => {
    const result = await call(deviceId, caller, action, signal)
    const label = await labelOf(deviceId)
    if (action.action === 'peers') {
      // session_peers 属 IM 域,结果不经会话工具那层 id 编码 ⇒ 这里直接给带类型的机器 id。
      const rows = Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
      for (const row of rows) if (typeof row.sessionId === 'string') known.set(row.sessionId, deviceId)
      return rows.map((row) => ({ ...row, device_id: encodeTypedId('device', deviceId), device_label: label }))
    }
    const sessionId = (result as { session_id?: unknown } | null)?.session_id
    if (action.action === 'spawn' && typeof sessionId === 'string') known.set(sessionId, deviceId)
    return action.action === 'spawn' ? onDevice(result, deviceId, label) : result
  }

  /**
   * session_children:一条会话的 child 可以在任何一台机器上 —— 本机那一份,加上在线机器各自那一份(离线的机器问不到)。
   * 机器清单读不到(没联网、没登录)时就是本机那一份:别的机器本来也够不着,❌ 为此让本机的列表失败。
   */
  const withRemoteChildren = async (local: unknown, sessionId: string | undefined, callerOf: () => Promise<RemoteSessionCaller>, signal?: AbortSignal) => {
    if (!Array.isArray(local)) return local
    let others: Device[]
    let caller: RemoteSessionCaller
    try {
      const { thisDeviceId, rows } = await devices()
      others = rows.filter((row) => row.device_id !== thisDeviceId && row.is_online && isAgentHostDevice(row))
      if (!others.length) return local
      caller = await callerOf()
    } catch {
      return local
    }
    const remote = await Promise.all(others.map(async (device) => {
      try {
        const action = sessionId === undefined ? { action: 'children' } : { action: 'children', session_id: sessionId }
        return onDevice(await call(device.device_id, caller, action, signal), device.device_id, device.label) as unknown[]
      } catch (error) {
        if (signal?.aborted) throw error
        return []
      }
    }))
    const at = (row: unknown) => Date.parse(String((row as { last_active_at?: unknown }).last_active_at ?? '')) || 0
    return [...local, ...remote.flat()].sort((a, b) => at(b) - at(a))
  }

  /** 那台机器上这几个 agent 各自的会话(按 Agent ID 发消息、打开 agent 的会话都按它找)。 */
  const sessionsOfAgents = async (deviceId: string, userIds: string[]): Promise<Map<string, string>> => {
    const device = await reachable(deviceId, true, undefined, true)
    const listed = await sessionsOn(device)
    // 协议 7 之前的老宿主:认不出它的 agent,当场说太旧(❌ 说成「不是你的 agent」)。
    if (!listed.listsAgents) {
      throw new CrossMachineError('SESSION_DEVICE_OUTDATED', `咕咕 on ${describe(device)} is too old to be reached by Agent ID; address its sessions as session:<id>. Nothing was sent there`)
    }
    return new Map(listed.sessions.flatMap((session) =>
      session.agent && userIds.includes(session.agent.userId) ? [[session.agent.userId, session.conversationId] as const] : []))
  }

  /** 一个 agent 在别的机器上的会话(打开它时):它在哪台(名册,或调用方已知),那台的会话表里它那条。在本机、找不到 = null。 */
  const sessionOfAgent = async (agentId: string, deviceId?: string): Promise<{ sessionId: string; deviceId: string } | null> => {
    const at = deviceId ?? (await deps.lookupAgents({ userIds: [agentId], numbers: [] })).find((row) => row.userId === agentId)?.deviceId
    if (!at || at === await deps.thisDeviceId()) return null
    const sessionId = (await sessionsOfAgents(at, [agentId])).get(agentId)
    return sessionId ? { sessionId, deviceId: at } : null
  }

  /** session_message 的远端那一格(见 unified-session-message.ts)。 */
  const messageDeps = (callerOf: () => Promise<RemoteSessionCaller>, signal?: AbortSignal): NonNullable<UnifiedSessionMessageDeps['remote']> => ({
    locateSessions: async (sessionIds) => {
      const { found, unasked } = await locateSessions(sessionIds, await callerOf(), signal)
      const missing = sessionIds.filter((id) => !found.has(id))
      return { found, missingMessage: missing.length ? notFoundMessage(missing, unasked) : null }
    },
    locateAgents: async (input) => {
      const rows = await deps.lookupAgents(input)
      return {
        byUserId: new Map(rows.map((row) => [row.userId, row.deviceId])),
        numberToUserId: new Map(rows.flatMap((row) => (row.guguNumber === null ? [] : [[row.guguNumber, row.userId] as const]))),
      }
    },
    thisDeviceId: deps.thisDeviceId,
    assertReachable: async (deviceIds) => {
      for (const deviceId of deviceIds) await reachable(deviceId, true, undefined, true)
    },
    sessionsOfAgents,
    deliver: async (deviceId, group) => {
      const result = await call(deviceId, await callerOf(), { action: 'message', session_ids: group.sessionIds, text: group.text, ...group.said }, signal) as { recipients?: UnifiedRecipientResult[] }
      return result?.recipients ?? []
    },
  })

  /**
   * 别的机器上的会话:每台在线机器报界面那份列表(手机目录读的同一个方法),整行交回。离线的机器只报 `since` 之后
   * 还在线过的(更早就离线的上面不可能有这棵树的 child);`since` = null 全报。
   */
  const sessionsElsewhere: OtherMachines['sessions'] = async (since, options) => {
    const { thisDeviceId, rows } = await devices()
    const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY
    const { sessions, unreached }: Awaited<ReturnType<OtherMachines['sessions']>> = { sessions: [], unreached: [] }
    await Promise.all(rows.filter((row) => row.device_id !== thisDeviceId).map(async (device) => {
      if (!isAgentHostDevice(device)) {
        unreached.push({ deviceId: device.device_id, label: device.label, detail: noTaskRuntime(device).message })
        return
      }
      if (!device.is_online) {
        if (!(Date.parse(device.last_seen_at) < sinceMs)) {
          unreached.push({
            deviceId: device.device_id,
            label: device.label,
            detail: `${describe(device)} is offline (last seen ${ago(device.last_seen_at, now())})`,
          })
        }
        return
      }
      try {
        const listed = await sessionsOn(device, options)
        for (const session of listed.sessions) sessions.push({ deviceId: device.device_id, label: device.label, session, listsAgents: listed.listsAgents })
      } catch (error) {
        unreached.push({ deviceId: device.device_id, label: device.label, detail: error instanceof Error ? error.message : String(error) })
      }
    }))
    return { sessions, unreached }
  }

  /** 那台机器上的一条会话:界面同一个方法,那边走的就是人在那台机器上点的归档。 */
  const archiveOn = async (deviceId: string, sessionId: string, removeSocialIdentity = true) => {
    const result = await request(await reachable(deviceId), 'sessionTimeline.sessionUpdate', [{ conversationId: sessionId, archived: true, removeSocialIdentity }], 30_000, 'archive') as
      | { ok: true }
      | { ok: false; error: { code: string; message: string } }
    if (!result.ok) throw new CrossMachineError(result.error.code, `on device:${deviceId}: ${result.error.message}`)
  }

  /** 这台机器上的一个 App 给别的机器上的一条会话发消息。 */
  const appMessage: OtherMachines['appMessage'] = async (app, deviceId, sessionId, text, how) => {
    const here = await thisDevice()
    const caller: RemoteAppCaller = { kind: 'app', deviceId: here.deviceId, deviceLabel: here.label, ...app }
    return await call(deviceId, caller, { action: 'message', session_ids: [sessionId], text, ...how } satisfies AppMessageAction) as AppMessageReceipt
  }

  /** 这台机器上的一个 App 页面让别的机器做一个跟着会话机器的动词(页面所在的会话在那台机器上)。 */
  const appCall: OtherMachines['appCall'] = async (app, deviceId, action) => {
    const here = await thisDevice()
    return await call(deviceId, { kind: 'app', deviceId: here.deviceId, deviceLabel: here.label, ...app } satisfies RemoteAppCaller, action)
  }

  const appSpawn: OtherMachines['appSpawn'] = async (app, deviceId, action) => {
    const here = await thisDevice()
    return await call(deviceId, { kind: 'app', deviceId: here.deviceId, deviceLabel: here.label, ...app } satisfies RemoteAppCaller, action) as { agentId: string }
  }

  /** 对端:答 `agentSession.<name>`。信任边界是账号(频道只对本账号开),这里认形状与调用方;错误带 `code` 原样回到发起方。 */
  const answer = async (name: AgentSessionActionName, rawCaller: unknown, rawAction: unknown, host: AgentSessionHost): Promise<unknown> => {
    const parsed = parseAgentSessionRequest(name, rawCaller, rawAction)
    if ('error' in parsed) throw new CrossMachineError('invalid_payload', parsed.error)
    try {
      if ('kind' in parsed.caller) {
        if (parsed.action.action === 'spawn') return await host.appSpawn(parsed.caller, parsed.action as AppSpawnAction)
        if (parsed.action.action === 'app_call') return await host.appCall(parsed.caller, parsed.action as AppCallAction)
        return await host.app(parsed.caller, parsed.action as AppMessageAction)
      }
      const { caller, action } = parsed as { caller: RemoteSessionCaller; action: AgentSessionAction }
      // 谁在哪台机器上发来的就记下:它派到这里的 child 回话时不必再挨台去问。
      known.set(caller.sessionId, caller.deviceId)
      if (action.action === 'peers') return await host.peers()
      return await host.run(caller, action)
    } catch (error) {
      if (error instanceof CrossMachineError) throw error
      // 带码的错误(App 发消息的 not-found / invalid、会话直投的 SESSION_DIRECT_*)码照用:发起方与本机看到同一个码。
      const code = typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'session_action_failed'
      throw new CrossMachineError(code, error instanceof Error ? error.message : String(error))
    }
  }

  const thisDevice = async (): Promise<{ deviceId: string; label: string | null }> => {
    const { thisDeviceId, rows } = await devices()
    return { deviceId: thisDeviceId, label: rows.find((row) => row.device_id === thisDeviceId)?.label ?? null }
  }

  return {
    devices: async () => {
      const { thisDeviceId, rows } = await devices()
      return deviceMachines(rows.map(device => ({ ...device, is_current_device: device.device_id === thisDeviceId })))
        .map(({ device: { device_id, label, is_online } }) => ({ deviceId: device_id, label, online: is_online, thisMachine: device_id === thisDeviceId }))
    },
    async listDeviceRows() {
      const [{ thisDeviceId, rows }, cloud] = await Promise.all([
        devices(),
        // 管家问不到不挡列机器:那一行就照库里的在线与否列(不标 cloud_computer)。
        deps.cloudComputerState?.().catch(() => null) ?? Promise.resolve(null),
      ])
      return deviceMachines(rows.map(device => ({ ...device, is_current_device: device.device_id === thisDeviceId })))
        .map(({ device }) => {
          // #7199 云电脑标出它此刻的样子:asleep 也接活 —— 把它当 device 传过去就会先叫醒它。
          const presence = cloudComputerPresence(device, cloud)
          return {
            device_id: device.device_id,
            label: device.label,
            kind: device.capabilities?.host_kind ?? null,
            task_runtime: {
              capability: device.capabilities?.host_runtime_capability ?? 0,
              runtimes: device.capabilities?.runtimes ?? [],
            },
            platform: device.platform,
            online: device.is_online,
            last_seen_at: device.last_seen_at,
            this_machine: device.device_id === thisDeviceId,
            ...(presence ? { cloud_computer: presence } : {}),
          }
        })
        .sort((a, b) =>
          Number(b.this_machine) - Number(a.this_machine)
          || Number(b.online) - Number(a.online)
          || Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at))
    },
    async activityDevices() {
      const { thisDeviceId, rows } = await devices()
      return rows.filter(isAgentHostDevice).map(d => ({ device_id: d.device_id, label: d.label,
        online: d.is_online, this_machine: d.device_id === thisDeviceId,
        session_titles: Object.fromEntries((d.session_digest ?? []).map(s => [s.conversationId, s.title])) }))
    },
    thisDevice,
    ensureReachable: async (deviceId: string, signal?: AbortSignal) => { await reachable(deviceId, true, signal, true); signal?.throwIfAborted() },
    isThisDevice: async (deviceId: string) => deviceId === await deps.thisDeviceId(),
    call,
    locateSessions,
    notFoundMessage,
    deviceOfSession,
    runOnSession,
    runOnDevice,
    withRemoteChildren,
    sessionsElsewhere,
    archiveOn,
    appMessage,
    appCall,
    appSpawn,
    messageDeps,
    sessionOfAgent,
    assertFileHandoffSupported,
    answer,
  }
}

/** `agentSession.<name>` 的参数:形状不对当场拒,❌ 带着 undefined 往下走。App 调用方(`kind: 'app'`)可发消息、起 agent、读文件、让那台机器做它页面的一个动词。 */
export function parseAgentSessionRequest(
  name: AgentSessionActionName,
  rawCaller: unknown,
  rawAction: unknown,
): { caller: RemoteCaller; action: AgentSessionAction } | { error: string } {
  const caller = rawCaller && typeof rawCaller === 'object' ? (rawCaller as Record<string, unknown>) : null
  const action = rawAction && typeof rawAction === 'object' ? (rawAction as Record<string, unknown>) : null
  if (!caller) return { error: 'caller is required' }
  if (!action || action.action !== name) return { error: `action must be { action: '${name}', … }` }
  const text = (key: string) => (typeof caller[key] === 'string' && (caller[key] as string).length > 0 ? (caller[key] as string) : null)
  const deviceId = text('deviceId')
  if (!deviceId) return { error: 'caller.deviceId is required' }
  if (caller.kind === 'app') {
    if (name !== 'message' && name !== 'spawn' && name !== 'app_call') {
      return { error: `an App may only send a message, start an agent, or have a page's call done on another machine, not ${name}` }
    }
    const extensionId = text('extensionId')
    const extensionName = text('extensionName')
    if (!extensionId || !extensionName) return { error: 'an App caller needs extensionId and extensionName' }
    if (name === 'spawn') {
      try {
        const checked = dispatchCallOf({ text: action.prompt, to: { new: true }, spawn: action.spawn })
        if (checked.spawn.device !== undefined) return { error: 'an App spawn is already routed to its device; spawn.device must be absent' }
        return {
          caller: { kind: 'app', deviceId, deviceLabel: text('deviceLabel'), extensionId, extensionName },
          action: { action: 'spawn', prompt: checked.text, spawn: checked.spawn },
        }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    }
    if (name === 'app_call') {
      // Which verbs that machine does for a page elsewhere, and their arguments, are the bridge's to judge (`BRIDGE_VERBS`).
      const { call_id: callId, session_id: sessionId, device_id: targetDevice, version, method, args } = action
      const target = typeof sessionId === 'string' && sessionId && targetDevice === undefined ? { session_id: sessionId }
        : typeof targetDevice === 'string' && targetDevice && sessionId === undefined ? { device_id: targetDevice } : null
      if (typeof callId !== 'string' || !callId || !target || typeof version !== 'string' || typeof method !== 'string'
        || !args || typeof args !== 'object' || Array.isArray(args)) {
        return { error: 'app_call names the call (call_id), exactly one session_id or device_id, the App\'s version, the verb (method) and its args (an object)' }
      }
      return {
        caller: { kind: 'app', deviceId, deviceLabel: text('deviceLabel'), extensionId, extensionName },
        action: { action: 'app_call', call_id: callId, ...target, version, method, args: args as Record<string, unknown> },
      }
    }
    const ids = action.session_ids
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== 'string' || typeof action.text !== 'string') {
      return { error: 'an App message names one session (session_ids: [id]) and text' }
    }
    const { delivery, key } = action
    if (delivery !== undefined && delivery !== 'queue' && delivery !== 'defer') return { error: 'delivery is queue or defer' }
    if (key !== undefined && (typeof key !== 'string' || !key)) return { error: 'key is a non-empty string' }
    return {
      caller: { kind: 'app', deviceId, deviceLabel: text('deviceLabel'), extensionId, extensionName },
      action: {
        action: 'message',
        session_ids: [ids[0]],
        text: action.text,
        ...(delivery ? { delivery } : {}),
        ...(typeof key === 'string' ? { key } : {}),
      },
    }
  }
  if (name === 'app_call') return { error: `${name} is for an App on another machine; an agent works on its own machine` }
  const sessionId = text('sessionId')
  if (!sessionId) return { error: 'caller.sessionId is required' }
  if (caller.transport !== 'acp' && caller.transport !== 'pty') return { error: 'caller.transport must be acp or pty' }
  let sessionAction = action as AgentSessionAction
  if (name === 'spawn') {
    // Older senders put nest on this wire. Keep that translation at the receiving boundary only.
    const { nest, ...spawn } = action
    if (spawn.parent_session_id === undefined && nest !== undefined && typeof nest !== 'boolean') return { error: 'nest must be a boolean' }
    if (spawn.parent_session_id !== undefined && spawn.parent_session_id !== null
      && (typeof spawn.parent_session_id !== 'string' || !spawn.parent_session_id)) {
      return { error: 'parent_session_id must be a session id or null' }
    }
    sessionAction = { ...spawn, ...(spawn.parent_session_id === undefined && nest === false ? { parent_session_id: null } : {}) } as AgentSessionAction
  }
  return {
    caller: {
      deviceId,
      deviceLabel: text('deviceLabel'),
      sessionId,
      agentUserId: text('agentUserId'),
      name: text('name'),
      harness: text('harness'),
      transport: caller.transport,
      model: text('model'),
      platformModel: text('platformModel'),
    },
    action: sessionAction,
  }
}
