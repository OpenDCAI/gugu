// @@@task-web-host — 浏览器形态下 electronAPI 桥面的实现:preload 那五个方法,四个过 WebSocket
// 连会话页宿主,getPathForFile 固定空串(浏览器拿不到本机绝对路径,调用点退化为传文件内容)。
// 协议见 src/session/shared/lib/ipc/host-ws-protocol.ts;宿主侧见 electron/session/main/host-ws/server.ts。
//
// 帧的收发、重连、看门狗在通用客户端(session/shared/lib/ipc/session-host-client.ts,远端机器也用它);
// 这里只管 WebSocket 这条线与地址解析。
import {
  HOST_WS_DEFAULT_PORT,
  HOST_WS_TOKEN_PARAM,
  HOST_WS_TOKEN_QUERY,
  HOST_WS_URL_PARAM,
} from '@/session/shared/lib/ipc/host-ws-protocol'
import {
  createSessionHostClient,
  type SessionHostConnectionState as SharedConnectionState,
  type SessionHostPipe,
  type SessionHostPipeOpener,
} from '@/session/shared/lib/ipc/session-host-client'
import { rendererLogger } from './log'

const log = rendererLogger('task-host/ws')

/**
 * 用户可见的三句断连文案。传输层不认 i18n(壳的 i18n 引导会把 localStorage / window 事件一并拖进来,
 * node 测试里直接炸),由壳在建客户端时注入本地化文案。
 */
export type SessionHostWsClientMessages = {
  hostNotConnected: string
  hostConnectionLost: string
  hostUnreachable: string
}

/** 会话页真正用到的桥面(preload 那五个成员);咕咕壳自己的那些方法不在此列。 */
export type SessionHostWsElectronApi = Pick<
  NonNullable<Window['electronAPI']>,
  'invoke' | 'eventSend' | 'eventOn' | 'getPathForFile' | 'requestWirePort'
>

export type SessionHostEndpoint = { url: string; token: string }

// vite.config.mts 的 define:dev serve 下无头宿主的地址与 token;生产 web 构建 / 单测为 null。
declare const __GUGU_SESSION_HOST_DEV__: SessionHostEndpoint | null | undefined

const STORAGE_KEY = 'gugu:task-host-endpoint'

/** 地址栏 `#sessionHost=ws://…&sessionHostToken=…` 优先;其次 dev 构建注入的;再次上次记住的;最后默认端口(无 token,宿主会拒)。 */
export function resolveSessionHostEndpoint(): SessionHostEndpoint {
  const fromHash = readHashEndpoint()
  if (fromHash) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fromHash))
    } catch {
      /* 私密窗口等情况写不进,无妨 */
    }
    return fromHash
  }
  if (typeof __GUGU_SESSION_HOST_DEV__ !== 'undefined' && __GUGU_SESSION_HOST_DEV__) {
    return __GUGU_SESSION_HOST_DEV__
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SessionHostEndpoint>
      if (typeof parsed.url === 'string' && typeof parsed.token === 'string') return parsed as SessionHostEndpoint
    }
  } catch {
    /* 坏数据当没有 */
  }
  return { url: `ws://127.0.0.1:${HOST_WS_DEFAULT_PORT}/`, token: '' }
}

function readHashEndpoint(): SessionHostEndpoint | null {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const url = params.get(HOST_WS_URL_PARAM)
  const token = params.get(HOST_WS_TOKEN_PARAM)
  if (!url || !token) return null
  // 用完就从地址栏抹掉 token,免得被复制/收藏带出去。
  params.delete(HOST_WS_URL_PARAM)
  params.delete(HOST_WS_TOKEN_PARAM)
  const rest = params.toString()
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`)
  return { url, token }
}

export function sessionHostSocketUrl(endpoint: SessionHostEndpoint): string {
  const url = new URL(endpoint.url)
  url.searchParams.set(HOST_WS_TOKEN_QUERY, endpoint.token)
  return url.toString()
}

export type SessionHostConnectionState = SharedConnectionState

export type SessionHostWsClient = {
  api: SessionHostWsElectronApi
  endpoint: SessionHostEndpoint
  state(): SessionHostConnectionState
  onStateChange(cb: (state: SessionHostConnectionState) => void): () => void
  connect(): Promise<void>
  close(): void
}

/** 一条 WebSocket 当一条帧线(浏览器形态):接上才 resolve,关了经 onClose 报。 */
function openWebSocketPipe(endpoint: SessionHostEndpoint): SessionHostPipeOpener {
  return ({ onFrame, onClose }) =>
    new Promise<SessionHostPipe>((resolve, reject) => {
      const ws = new WebSocket(sessionHostSocketUrl(endpoint))
      ws.binaryType = 'arraybuffer'
      let opened = false
      ws.onopen = () => {
        opened = true
        resolve({
          send: (frame) => {
            if (ws.readyState !== WebSocket.OPEN) throw new Error('socket closed')
            ws.send(frame as string | Uint8Array<ArrayBuffer>)
          },
          close: () => ws.close(4000, 'stale'),
        })
      }
      ws.onmessage = (ev) => onFrame(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer))
      ws.onerror = () => {
        /* onclose 紧随其后,统一在那里处理 */
      }
      ws.onclose = (ev) => {
        // 原因进日志,用户文案只留下一步(user-copy-leak 棘轮)。
        log.warn({ url: endpoint.url, code: ev.code, reason: ev.reason }, '会话页宿主连接关闭')
        if (opened) onClose(`ws ${ev.code}`)
        else reject(new Error(`ws ${ev.code}`))
      }
    })
}

export function createSessionHostWsClient(
  endpoint: SessionHostEndpoint,
  options: { messages?: Partial<SessionHostWsClientMessages>; staleMs?: number } = {},
): SessionHostWsClient {
  const client = createSessionHostClient(openWebSocketPipe(endpoint), {
    messages: options.messages,
    staleMs: options.staleMs,
    subscribeEvents: true,
    // 与 preload 的 window.postMessage({kind: '<ch>:port'}, '*', [port]) 同构:端口交给页面(session-wire 的 awaitWirePort 在等)。
    deliverPortToPage: (channel, port) => window.postMessage({ kind: channel }, '*', [port]),
  })
  return {
    api: client.api,
    endpoint,
    state: client.state,
    onStateChange: client.onStateChange,
    connect: client.connect,
    close: client.close,
  }
}
