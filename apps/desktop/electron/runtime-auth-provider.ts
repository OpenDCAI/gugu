import { RuntimeAuthExpiredError, type RuntimeAuth, type RuntimeAuthProvider } from '@gugu/core'

/**
 * F33 渲染进程推给主进程的会话 —— 桌面主进程登录态的唯一来源。GoTrue 会话本体在渲染进程里，协调器每接受一次会话
 * (登录、每次续期)就经 `human-auth-session:write` 推一份过来，登出 / 会话永久丢失时经 `human-auth-session:clear` 说一声、
 * 并说清是哪一种。主进程 ❌ 回头去问渲染进程，也 ❌ 自己续期(续期只归渲染进程的协调器,#6736)。
 *
 * `undefined` = 本进程起来后还没收到过(冷启动、协调器还没恢复完会话):当作没登录 —— 推送一到,
 * `onHumanAuthSessionChanged` 就叫设备宿主当场重新确立 owner。`null` = 登出了。`'lost'` = 会话永久丢了(#484)。
 */
export type PushedRuntimeAuth = RuntimeAuth | 'lost' | null | undefined

export function createPushedRuntimeAuthProvider(pushedAuth: () => PushedRuntimeAuth): RuntimeAuthProvider {
  return {
    async getAuth() {
      const pushed = pushedAuth()
      // 永久丢失 → 带类型的错，宿主据此发一次性的独立信号。
      if (pushed === 'lost') throw new RuntimeAuthExpiredError('Session permanently lost')
      return pushed ?? null
    },
  }
}
