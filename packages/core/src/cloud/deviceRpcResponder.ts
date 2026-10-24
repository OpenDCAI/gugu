import { homedir } from 'node:os'
import { DEVICE_ACTION_RPC_TYPE, DEVICE_ACTION_RESULT_ACK_RPC_TYPE } from '../shared/deviceActions'
import { listDeviceDirectory, makeDeviceDirectory } from './deviceFs'
import {
  createDeviceRpcReplyEnvelope,
  parseDeviceRpcRequest,
  type DeviceRpcRequestEnvelope,
  type DeviceRpcResponse,
} from './deviceRpcProtocol'
import type { DeviceFsListPayload, DeviceFsMakeDirectoryPayload } from './deviceFsProtocol'

/**
 * Realtime channel contract a device-rpc consumer drives. Hoisted here (was duplicated
 * byte-identical in apps/desktop/electron/device-rpc-responder.ts and
 * apps/terminal/src/deviceRpcResponder.ts) so both transport implementations share one
 * definition. Minimal surface: what createDeviceRpcRequestHandler's publishReply + the
 * subscription wiring actually touch.
 */
export type DeviceRpcChannel = {
  on: (
    kind: 'broadcast',
    filter: { event: string },
    callback: (payload: unknown) => void
  ) => DeviceRpcChannel
  subscribe: (callback: (status: string, err?: Error) => void) => DeviceRpcChannel
  send: (message: { type: 'broadcast'; event: string; payload: unknown }) => Promise<unknown>
}

/**
 * Supabase realtime client contract a device-rpc consumer needs: auth, channel creation,
 * and channel teardown. Generic over the platform's native channel type (Electron-managed
 * vs raw). Hoisted from the two apps-side copies.
 */
export type DeviceRpcSupabaseClient<TChannel> = {
  realtime: {
    setAuth: (accessToken: string) => unknown | Promise<unknown>
  }
  channel: (
    topic: string,
    options: { config: { private: boolean; broadcast: { self: boolean; ack: boolean } } }
  ) => TChannel
  removeChannel: (channel: TChannel) => unknown
}

/**
 * Host-side device RPC responder. The handler is pure transport-agnostic: the host owns
 * channel subscription + reply send (mirroring the SubscribeDeviceCommandWake seam) and
 * injects a publishReply callback per inbound request.
 */
export type PublishDeviceRpcReply = (payload: {
  type: string
  request_id: string
  result?: unknown
  error?: { code: string; message: string }
}) => Promise<unknown> | unknown

/**
 * 主动广播：桌面 → 手机的推送，同一条频道、同一个 `broadcast` 事件，但**没有 request_id**
 * （它不是任何一次请求的应答）。会话页窗口的帧（taskhost.frame）走的就是这个口。
 */
export type PublishDeviceRpcEvent = (payload: unknown) => Promise<unknown> | unknown

/**
 * #7233 这一问来自哪个发问端(咕咕云上它自己那条 topic)。宿主离开那条(空闲 / 让位 / 宿主收摊)时回调 —— 经它开的
 * 会话页窗口据此关掉:帧已经推不过去了,留着就是「以为还有人在看」。远程 SSH 的设备连接上没有它(一条连接一个发问端)。
 */
export type DeviceRpcAskerContext = { id: string; onDetached(callback: () => void): () => void }

export type DeviceRpcHandlerContext = {
  /** 完整请求信封 —— 处理器要认发起人（user_id）时读它。 */
  request: DeviceRpcRequestEnvelope
  env: NodeJS.ProcessEnv
  /**
   * 往发问端那条推事件(咕咕云:它自己的 topic;SSH:那条连接)。没有活着的频道时是 no-op（返回 undefined）——
   * 调用方据此**不能**推断「推成功了」，订阅的存活由订阅方自己的重连保证。
   */
  publishEvent: PublishDeviceRpcEvent
  asker?: DeviceRpcAskerContext
}

export type DeviceRpcHandler = (
  payload: unknown,
  ctx: DeviceRpcHandlerContext,
) => Promise<DeviceRpcResponse<unknown>> | DeviceRpcResponse<unknown>

export type DeviceRpcHandlers = Record<string, DeviceRpcHandler>

/**
 * 内建处理器。**先建表再查表**，取代原来那条写死的 if —— 但内建的这一条仍然由本模块拥有：
 * 外面传进来的注册表撞上内建类型时**构造期就抛**，❌ 不静默让调用方顶掉 `fs.list-directory`
 * （那会让「手机的文件浏览忽然读到别的东西」变成一次悄无声息的注册顺序问题）。
 */
function builtinHandlers(): DeviceRpcHandlers {
  return {
    'fs.list-directory': (payload, ctx) =>
      listDeviceDirectory(payload as DeviceFsListPayload, {
        homedir: () => ctx.env.HOME ?? homedir(),
      }),
    'fs.make-directory': (payload, ctx) =>
      makeDeviceDirectory(payload as DeviceFsMakeDirectoryPayload, {
        homedir: () => ctx.env.HOME ?? homedir(),
      }),
  }
}

/** 记住最近这么多问的答复(按 request_id):发问端重发同一问时回上次的,❌ 再办一遍。 */
const REPLAY_REQUESTS = 512
/** 只留这么大以内的答复(上传一片、发一句、开窗口的应答都很小);大的(一张图、一份快照)只记「办过」,重发时再取一次 —— 它们都是读。 */
const REPLAY_MAX_CHARS = 64 * 1024

export function createDeviceRpcRequestHandler(options?: {
  env?: NodeJS.ProcessEnv
  warn?: (message: string) => void
  /** 宿主自己的处理器，按请求 type 注册（如 taskhost.*、taskpage.preview.*）。 */
  handlers?: DeviceRpcHandlers
}): (
  payload: unknown,
  publishReply: PublishDeviceRpcReply,
  publishEvent?: PublishDeviceRpcEvent,
  asker?: DeviceRpcAskerContext,
) => Promise<void> {
  const env = options?.env ?? process.env
  const warn = options?.warn ?? (() => undefined)
  const registry = builtinHandlers()
  for (const [type, handler] of Object.entries(options?.handlers ?? {})) {
    if (registry[type]) {
      throw new Error(`[device-rpc] handler for built-in type '${type}' cannot be overridden`)
    }
    registry[type] = handler
  }
  const noEvent: PublishDeviceRpcEvent = () => undefined
  /**
   * #7233 发问端一问超时会重新报到、原样重发一次(同一个 request_id):多半是答复没送到,事情已经办了。按 request_id 记住
   * 最近的:还在办的等它办完、办完的回上次的答复 —— 上传的一片、发出去的一句、开的窗口都 ❌ 再来一遍。
   * 大答复不留(`REPLAY_MAX_CHARS`),只记「办过」,重发时照常再办一遍:它们是读(一张图、一份快照)。
   */
  const replies = new Map<string, Promise<ReturnType<typeof createDeviceRpcReplyEnvelope> | null>>()
  const answer = async (request: DeviceRpcRequestEnvelope, publishEvent: PublishDeviceRpcEvent | undefined, asker: DeviceRpcAskerContext | undefined) => {
    let response: DeviceRpcResponse<unknown>
    try {
      const handler = registry[request.type]
      response = handler
        ? await handler(request.payload, {
            request,
            env,
            publishEvent: publishEvent ?? noEvent,
            ...(asker ? { asker } : {}),
          })
        : { error: { code: 'unknown_method', message: `unknown device RPC type: ${request.type}` } }
    } catch (error) {
      response = { error: { code: 'internal_error', message: (error as Error)?.message ?? String(error) } }
    }
    return createDeviceRpcReplyEnvelope(request.type, request.request_id, response)
  }
  return async (payload, publishReply, publishEvent, asker) => {
    const request = parseDeviceRpcRequest(payload)
    if (!request) return
    // @@@ignore-replies - we receive every broadcast on the channel; never answer a reply envelope
    // (self:false already drops our own, but a second host on the same device must not reply-loop).
    if (request.type.endsWith(':reply')) return
    let envelope: ReturnType<typeof createDeviceRpcReplyEnvelope> | null = null
    // Device action refusals must not be replaced by a cached reply for a reused request id.
    const deviceAction = request.type === DEVICE_ACTION_RPC_TYPE || request.type === DEVICE_ACTION_RESULT_ACK_RPC_TYPE
    const earlier = deviceAction ? undefined : replies.get(request.request_id)
    if (earlier) envelope = await earlier
    if (!envelope) {
      const answering = answer(request, publishEvent, asker)
      if (!deviceAction) {
        replies.delete(request.request_id)
        replies.set(request.request_id, answering.then((done) => (JSON.stringify(done).length <= REPLAY_MAX_CHARS ? done : null)))
      }
      while (replies.size > REPLAY_REQUESTS) replies.delete(replies.keys().next().value as string)
      envelope = await answering
    }
    try {
      await publishReply(envelope)
    } catch (error) {
      warn(`[device-rpc] reply publish failed: ${(error as Error)?.message ?? String(error)}`)
    }
  }
}
