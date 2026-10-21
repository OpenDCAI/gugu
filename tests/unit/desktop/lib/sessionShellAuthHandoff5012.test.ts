// @@@task-shell-port (#5012) — 网页版把登录态交给任务宿主的三个时机与去重口径。
// 宿主重启会丢掉上一份登录态,所以「宿主重连」这一次必须**强制**重推,哪怕登录态一个字节没变 ——
// 这正是去重会吃掉的那一次,也是这里最该有判据的一格。
import { describe, expect, it, vi } from 'vitest'
import {
  identityAuthOf,
  installSessionShellAuthHandoff,
} from '../../../../apps/desktop/src/lib/session-shell-auth-handoff'
type SessionLike = { access_token: string; refresh_token: string; user: { id: string } } | null
function harness(initial: SessionLike) {
  let session = initial
  const sessionListeners = new Set<() => void>()
  const openListeners = new Set<() => void>()
  const sent: unknown[] = []
  const hostInvoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    expect(channel).toBe('sessionpageIdentity.setAuth')
    sent.push(args[0])
    return undefined
  })
  const stop = installSessionShellAuthHandoff({
    hostInvoke,
    onHostOpen: (cb) => {
      openListeners.add(cb)
      return () => openListeners.delete(cb)
    },
    getSession: () => session,
    observeSession: (listener) => {
      const wrapped = () => listener({ session })
      sessionListeners.add(wrapped)
      return () => sessionListeners.delete(wrapped)
    },
  })
  return {
    sent,
    stop,
    setSession(next: SessionLike) {
      session = next
      sessionListeners.forEach((fn) => fn())
    },
    hostReconnected() {
      openListeners.forEach((fn) => fn())
    },
    listenerCounts: () => sessionListeners.size + openListeners.size,
  }
}
const SESSION = { access_token: 'tok-1', refresh_token: 'ref-1', user: { id: 'owner-1' } }
describe('installSessionShellAuthHandoff', () => {
  it('装桥时推一次;登录态没变时不重复推', () => {
    const h = harness(SESSION)
    expect(h.sent).toEqual([{ accessToken: 'tok-1', refreshToken: 'ref-1', userId: 'owner-1' }])
    h.setSession(SESSION)
    expect(h.sent).toHaveLength(1)
  })
  it('续期(access token 变了)与登出各推一次', () => {
    const h = harness(SESSION)
    h.setSession({ ...SESSION, access_token: 'tok-2' })
    h.setSession(null)
    expect(h.sent).toEqual([
      { accessToken: 'tok-1', refreshToken: 'ref-1', userId: 'owner-1' },
      { accessToken: 'tok-2', refreshToken: 'ref-1', userId: 'owner-1' },
      null,
    ])
  })
  it('宿主重连即使登录态未变也强制重推 —— 宿主重启后手里是空的', () => {
    const h = harness(SESSION)
    h.hostReconnected()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toEqual(h.sent[0])
  })
  it('卸载后不再推(❌ 页面切走还挂着监听)', () => {
    const h = harness(SESSION)
    h.stop()
    expect(h.listenerCounts()).toBe(0)
    h.setSession({ ...SESSION, access_token: 'tok-3' })
    expect(h.sent).toHaveLength(1)
  })
})
describe('identityAuthOf', () => {
  it('缺 access token 或缺 user 都读作「没有登录态」,❌ 交一份半截的给宿主', () => {
    expect(identityAuthOf(SESSION)).toEqual({ accessToken: 'tok-1', refreshToken: 'ref-1', userId: 'owner-1' })
    expect(identityAuthOf(null)).toBeNull()
    expect(identityAuthOf({ access_token: '', refresh_token: 'r', user: { id: 'u' } })).toBeNull()
    expect(identityAuthOf({ access_token: 't', refresh_token: 'r', user: { id: '' } })).toBeNull()
  })
})
