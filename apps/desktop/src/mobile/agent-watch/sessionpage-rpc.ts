import type { RpcRouter } from '@main/rpc'
import type { ToolImage } from '@gugu/session-core/acp/client'
import { rendererLogger } from '@/lib/log'
import { readCachedDevices } from '@/store/devicesCache'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { appCallWaitMs, type AppCallAction } from '@gugu/session-core/session-record/contract'
import { callDeviceRpc } from '@/lib/deviceRpc'
import { openPhoneSessionHostPipe } from '@/lib/remoteSessionHost'
import { SESSION_HOST_RPC } from '@/session/shared/lib/ipc/session-host-device-frames'
import { createRPCClient } from '@/session/shared/lib/ipc/rpc'
import { linkChangesOf } from '@/session/shared/remote-sessions/session-list-sync'
import {
  createSessionHostClient,
  SESSION_HOST_CLIENT_HEARTBEAT_MS,
  type SessionHostClient,
} from '@/session/shared/lib/ipc/session-host-client'
import {
  sessionpageSessionListChannel,
  sessionpageSessionTimelineChannel,
} from '@/session/shared/core/session-timeline/sessionTimelineEvents'
import type {
  SessionpageOpenedFileChunk,
  SessionpageOpenedFileReadRequest,
  SessionpageSessionRespondRequest,
  SessionpageSessionRespondResult,
  SessionpageSessionSetOptionRequest,
  SessionpageSessionReloadModelRequest,
  SessionpageSessionsEvent,
  SessionpageSessionEvent,
  TimelineAfterResult,
  TimelineOlderResult,
  TimelineSnapshot,
  RecordCursor,
  SessionpageSessionCreateModels,
  SessionpageSessionCreateOptions,
  SessionpageSessionView,
  SessionpageSessionCreateRequest,
  SessionpageSessionCreateResult,
} from '@gugu/session-core/session-record/contract'
// ⚠️ 只能从 `/contract` 取,❌ 不许写成 `@gugu/session-core/session-record`:那个 barrel 会往下拖
// node:fs 与 better-sqlite3(宿主侧的记录源),浏览器里首屏直接白屏 —— 实测过一次。
import type { SessionpageSessionOptionsWithMenu } from '@main/core/session-timeline/session-model-menu'

/**
 * 手机 → 某台机器的会话页:与别的电脑同一条线(`taskhost.*` 窗口)、同一张有类型的路由表(`sessionTimeline.*`)。
 * 每台机器一条窗口,懒开;断了自己按退避重开(session-host-client)。推送按订阅号走,订阅跟着窗口生灭 ——
 * 窗口重开过就要重订(`onLinkChange` 报 open)。
 *
 * 读时间线一律带 `trim`:过长的工具内容在那台机器上就裁掉,手机不收整份。
 */
const log = rendererLogger('mobile/agent-watch')
const hosts = new Map<string, SessionHostClient>()

function host(deviceId: string): SessionHostClient {
  let client = hosts.get(deviceId)
  if (!client) {
    client = createSessionHostClient(openPhoneSessionHostPipe(deviceId), {
      subscribeEvents: true,
      heartbeatMs: SESSION_HOST_CLIENT_HEARTBEAT_MS,
      retryMaxMs: 60_000,
      warn: (message, detail) => log.warn({ machine: deviceId.slice(0, 8), ...detail }, message),
      // 连不上 / 太旧时界面摆出来的那句话:说哪台机器、哪一边旧,❌ 英文的传输层原文(与桌面 machine-clients 同一组文案)。
      messages: () => {
        const device = readCachedDevices().find((row) => row.device_id === deviceId)?.label ?? deviceId.slice(0, 8)
        const unreachable = translateSessionMessage('deviceScope.unreachable', { device })
        return {
          hostNotConnected: unreachable,
          hostConnectionLost: unreachable,
          hostUnreachable: unreachable,
          hostTooOld: translateSessionMessage('deviceScope.serverTooOld', { device }),
          clientTooOld: translateSessionMessage('deviceScope.thisTooOld', { device }),
        }
      },
    })
    hosts.set(deviceId, client)
  }
  return client
}

/*
 * 网络回来 / 页面回到前台:没通着的窗口当场重开,❌ 等退避(断网期间一次次重连失败,退避已经攒到几十秒)。
 * 通着的不动:线死没死由 realtime 那层判(网络回来时问 socket 一拍心跳,见 realtimeChannel.ts),频道重订上时死了的窗口自己会关。
 * 由事件驱动,❌ 定时器、❌ 心跳(原来 keepalive 的那份职责交给这两个事件)。
 */
if (typeof window !== 'undefined') {
  const reopenClosed = () => {
    for (const client of hosts.values()) if (client.state() !== 'open') client.reconnectNow()
  }
  window.addEventListener('online', reopenClosed)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reopenClosed()
  })
}

function rpc(deviceId: string) {
  return createRPCClient<RpcRouter>((channel, ...args) => host(deviceId).api.invoke(channel, ...args))
}

/**
 * #7199 手机助理 App 问云电脑(读记忆、列已安排):同一条线、同一张路由表上的别的动词 —— 与桌面 `rpcOn` 一样的那组,
 * ❌ 为它另开协议。
 */
export function machineRpc(deviceId: string) {
  return rpc(deviceId)
}

/**
 * 同一张路由表,一问一答、不等窗口(`taskhost.call`)。回前台补齐用它:离开超过宿主判窗口死的那 40 s,窗口要重开、
 * 重订,补齐那一问 ❌ 排在它后面(安卓实测回前台要多 1–2.5 s)。窗口照样在后台重开,推送仍只走窗口。
 */
function once(deviceId: string) {
  return createRPCClient<RpcRouter>(async (channel, ...args) => {
    const reply = await callDeviceRpc<{ value: unknown }>(deviceId, SESSION_HOST_RPC.call, { channel, args }, { timeoutMs: 12_000 })
    if (reply.error) throw new SessionpageRpcError(reply.error.code, reply.error.message)
    return reply.result?.value
  })
}

/**
 * owner 10-16 An App page on the phone, in a session on this machine, has one of its calls that follow the session's
 * machine (its data folder, its program) done there — the cross-machine App call the desktop makes (`agentSession.app_call`,
 * one question and answer). The wait is the desktop's (`remoteActionTimeoutMs`): a program call, its program's own request
 * bound (60 s) and the way back. A machine too old to have it answers `unknown_method` / no handler.
 */
export async function appCallOn(deviceId: string, caller: unknown, action: AppCallAction): Promise<unknown> {
  const reply = await callDeviceRpc<{ value: unknown }>(deviceId, SESSION_HOST_RPC.call, { channel: 'agentSession.app_call', args: [caller, action] }, { timeoutMs: appCallWaitMs(action) })
  if (reply.error) throw new SessionpageRpcError(reply.error.code, reply.error.message)
  return reply.result?.value
}

/** A push of that machine's on a channel of its own (e.g. `extensions.program.notified`), heard through its window. */
export function onMachineChannel(deviceId: string, channel: string, cb: (data: unknown) => void): () => void {
  return host(deviceId).api.eventOn(channel, cb)
}

export class SessionpageRpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SessionpageRpcError'
    this.code = code
  }
}

/** 那台机器回的 `{ok:false, error}`:原文原样带出来(fail loud),由调用方决定怎么呈现。 */
async function value<T>(pending: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new SessionpageRpcError(result.error.code, result.error.message)
  return result.value
}

export function fetchSnapshot(deviceId: string, sessionId: string, limit?: number): Promise<TimelineSnapshot> {
  return value(rpc(deviceId).sessionTimeline.sessionSnapshot({ conversationId: sessionId, limit, trim: true }))
}

/** 补齐:一问一答,不等窗口(见 `once`)。 */
export function fetchAfter(deviceId: string, sessionId: string, cursor: RecordCursor): Promise<TimelineAfterResult> {
  return value(once(deviceId).sessionTimeline.sessionAfter({ conversationId: sessionId, cursor, trim: true }))
}

export function fetchOlder(deviceId: string, sessionId: string, beforeTurnId: string, limit?: number): Promise<TimelineOlderResult> {
  return value(rpc(deviceId).sessionTimeline.sessionOlder({ conversationId: sessionId, beforeTurnId, limit, trim: true }))
}

/**
 * 一张工具交回来的图:发给手机的时间线里只有它的类型和字数(transport-trim),图滚进视口、那一轮展开了才来取。
 * 同一张路由表(那台机器的会话时间线),❌ 另开通道;取到的写回条目、跟着 timeline-cache 存。
 * 走 `once`、不走窗口:一问一答有 12 秒期限,回包是一条独立的广播,不进窗口的按序队列 —— 一片丢了不会把这条会话的
 * 推送一起压住,手机也不会对着一张图一直等(窗口的问没有期限,要等到线被判死)。单张上限见 `TOOL_IMAGE_FETCH_LIMIT`。
 */
export function fetchToolImage(deviceId: string, sessionId: string, itemId: string, index: number): Promise<ToolImage> {
  return value(once(deviceId).sessionTimeline.sessionToolImage({ conversationId: sessionId, itemId, index }))
}

export function subscribeSession(deviceId: string, sessionId: string, subscriptionId: string, cursor: RecordCursor | null): Promise<unknown> {
  return value(rpc(deviceId).sessionTimeline.sessionSubscribe({ conversationId: sessionId, subscriptionId, cursor, trim: true }))
}

export function unsubscribeSession(deviceId: string, subscriptionId: string): Promise<unknown> {
  return rpc(deviceId).sessionTimeline.sessionUnsubscribe({ subscriptionId })
}

export function sendSessionText(deviceId: string, sessionId: string, text: string): Promise<unknown> {
  return value(rpc(deviceId).sessionTimeline.sessionSend({ conversationId: sessionId, text }))
}

/** 输入框附件:桌面输入框同三条(`sessionCreate.*`),问的是会话所在的那台机器。 */
export function sessionAttachmentRpc(deviceId: string) {
  return rpc(deviceId).sessionCreate
}

/** 附件卡(#7193):这条会话打开给人看的那份文件,读一段(那台机器核对它真的打开过)。 */
export function readOpenedFileChunk(deviceId: string, request: SessionpageOpenedFileReadRequest): Promise<SessionpageOpenedFileChunk> {
  return value(rpc(deviceId).sessionTimeline.sessionOpenedFileRead(request))
}

/** 停掉正在飞的一轮。受理即返回,停没停下来看时间线。 */
export function cancelSessionTurn(deviceId: string, sessionId: string): Promise<{ cancelled: boolean }> {
  return value(rpc(deviceId).sessionTimeline.sessionCancel({ conversationId: sessionId }))
}

/** 重命名 / 置顶 / 归档(桌面侧栏同三条)。 */
export function updateSession(
  deviceId: string,
  input: { conversationId: string; title?: string; pinned?: boolean; archived?: true },
): Promise<{ title: string; isPinned: boolean; archived: boolean }> {
  return value(rpc(deviceId).sessionTimeline.sessionUpdate(input))
}

export function respondToSettlement(deviceId: string, input: SessionpageSessionRespondRequest): Promise<SessionpageSessionRespondResult> {
  return value(rpc(deviceId).sessionTimeline.sessionRespond(input))
}

/** 这条会话订阅的推送(只有这个订阅号的:事件 topic 就是它)。 */
export function subscribeSessionEvents(deviceId: string, subscriptionId: string, onResult: (result: TimelineAfterResult) => void): () => void {
  return host(deviceId).api.eventOn(`${sessionpageSessionTimelineChannel.name}.${subscriptionId}`, (event) =>
    onResult((event as SessionpageSessionEvent).result))
}

export function fetchSessionOptions(deviceId: string, sessionId: string): Promise<SessionpageSessionOptionsWithMenu> {
  return value(rpc(deviceId).sessionTimeline.sessionOptions({ conversationId: sessionId }))
}

export function setSessionOption(deviceId: string, input: SessionpageSessionSetOptionRequest): Promise<SessionpageSessionOptionsWithMenu> {
  return value(rpc(deviceId).sessionTimeline.sessionSetOption(input))
}

export function reloadSessionModel(deviceId: string, input: SessionpageSessionReloadModelRequest): Promise<SessionpageSessionOptionsWithMenu> {
  return value(rpc(deviceId).sessionTimeline.sessionReloadModel(input))
}

/** 新建会话前先问那台机器:有哪些项目、装了哪几家 harness。 */
export function fetchCreateOptions(deviceId: string): Promise<SessionpageSessionCreateOptions> {
  return value(rpc(deviceId).sessionTimeline.sessionCreateOptions())
}

/** 选定 harness 在那台机器上能跑哪些模型。 */
export function fetchCreateModels(
  deviceId: string,
  harness: string,
  sessionView: SessionpageSessionView | null,
  model: string | null,
): Promise<SessionpageSessionCreateModels> {
  return value(rpc(deviceId).sessionTimeline.sessionCreateModels({
    harness,
    ...(sessionView ? { sessionView } : {}),
    ...(model ? { model } : {}),
  }))
}

/** **在那台机器上开一条新会话。**只在用户点了发送之后调 —— 它会在对方机器上起一个 agent 进程。 */
export function createSession(deviceId: string, request: SessionpageSessionCreateRequest): Promise<SessionpageSessionCreateResult> {
  return value(rpc(deviceId).sessionTimeline.sessionCreate(request))
}

export function subscribeSessionsList(deviceId: string, subscriptionId: string): Promise<unknown> {
  return value(rpc(deviceId).sessionTimeline.sessionsSubscribe({ subscriptionId }))
}

export function unsubscribeSessionsList(deviceId: string, subscriptionId: string): Promise<unknown> {
  return rpc(deviceId).sessionTimeline.sessionsUnsubscribe({ subscriptionId })
}

/** 这条列表订阅的推送:订上那一刻一份整的,之后只有变了的行(合并见 applySessionListEvent)。 */
export function subscribeSessionsListEvents(
  deviceId: string,
  subscriptionId: string,
  onEvent: (event: SessionpageSessionsEvent) => void,
): () => void {
  return host(deviceId).api.eventOn(`${sessionpageSessionListChannel.name}.${subscriptionId}`, (event) =>
    onEvent(event as SessionpageSessionsEvent))
}

/**
 * 到那台机器的窗口通过一次之后:断了报 false,又通了报 true。又通 = 那台机器已经拆了上一条窗口上的订阅
 * (订阅跟着窗口生灭),调用方要重订、补齐。广播丢了一批推送也走这里:收帧有缺口时后面的帧(连心跳)都卡在
 * 缺口后面,看门狗认出静默就关掉重开。第一次就接通不报 —— 那时调用方正在订;开线失败过(落回 closed)再接通要报:
 * 调用方那时发的问已随失败的那次落空,❌ 让它等自己的退避(冷启动实撞:晚 5 s)。
 */
export function onLinkChange(deviceId: string, cb: (open: boolean) => void): () => void {
  return linkChangesOf(host(deviceId), cb)
}

/**
 * 那台机器主进程推的一种不带 topic 的事件(GitHub 设备码等,手机连接应用页要听它),订在同一条窗口上;返回退订。
 * 先订、再发起会推它的那一问:❌ 反过来 —— 推送比订阅先到就丢了。
 */
export function onMachineEvent<T>(deviceId: string, event: { name: string; _data?: T }, cb: (data: T) => void): () => void {
  return host(deviceId).api.eventOn(event.name, (data) => cb(data as T))
}
