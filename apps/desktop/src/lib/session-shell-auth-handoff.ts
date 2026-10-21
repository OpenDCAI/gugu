// @@@task-shell-port (#5012) — 网页版:浏览器把登录态按次交给任务宿主。
//
// 宿主是用户自己的机器,与桌面主进程同一信任级别;它拿登录态只为给会话开咕咕账号。三个时机各推一次:
// 装桥时(已登录则立刻)、登录态变化时(登录 / 续期 / 登出)、宿主重连时(宿主重启会丢掉上一份)。
// 宿主 ❌ 不自行刷新:refresh token 轮换会让浏览器与宿主其中一方失效,续期只由浏览器做、做完推过去。
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { createRPCClient } from '@/session/shared/lib/ipc/rpc'
import type { SessionShellInvoke } from '@/session/shared/lib/ipc/shell-port'
import type {
  SessionpageIdentityAuth,
  SessionpageIdentityRouter,
} from '@/session/shared/lib/ipc/sessionpage-identity-contract'
import { rendererLogger } from './log'

const log = rendererLogger('session-host/identity-auth')

type SessionLike = { access_token: string; refresh_token: string; user: { id: string } } | null

export function identityAuthOf(session: SessionLike): SessionpageIdentityAuth | null {
  if (!session?.access_token || !session.user?.id) return null
  return { accessToken: session.access_token, refreshToken: session.refresh_token ?? '', userId: session.user.id }
}

export function installSessionShellAuthHandoff(options: {
  hostInvoke: SessionShellInvoke
  /** 宿主连接状态变化(task-host-ws-client.onStateChange);'open' 时重推。 */
  onHostOpen: (cb: () => void) => () => void
  getSession?: () => SessionLike
  observeSession?: (listener: (change: { session: SessionLike }) => void) => () => void
}): () => void {
  const host = createRPCClient<SessionpageIdentityRouter>(options.hostInvoke)
  const getSession = options.getSession ?? (() => getRendererSession() as SessionLike)
  const observeSession = options.observeSession ?? observeRendererSession
  let last: string | null = null
  const push = (reason: string, force = false) => {
    const auth = identityAuthOf(getSession())
    const key = auth ? `${auth.userId}:${auth.accessToken}` : 'none'
    if (!force && key === last) return
    last = key
    host.sessionpageIdentity.setAuth(auth).catch((error: unknown) => {
      last = null
      log.warn({ reason, error }, '登录态交给会话页宿主失败')
    })
  }
  push('install')
  const stopSession = observeSession(() => push('session-change'))
  const stopOpen = options.onHostOpen(() => push('host-open', true))
  return () => {
    stopSession()
    stopOpen()
  }
}
