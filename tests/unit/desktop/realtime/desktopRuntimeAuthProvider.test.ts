import { describe, expect, test } from 'vitest'
import { RuntimeAuthExpiredError, runtimeAuthFromSupabaseTokens } from '@gugu/core'
import {
  createPushedRuntimeAuthProvider,
  type PushedRuntimeAuth
} from '../../../../apps/desktop/electron/runtime-auth-provider'

function tokenForSub(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64url')
  return `header.${payload}.sig`
}

describe('桌面主进程的登录态只看渲染进程推来的那份(F33)', () => {
  test('推来了就用它;换了一份就用新的', async () => {
    let pushed: PushedRuntimeAuth = runtimeAuthFromSupabaseTokens({ accessToken: tokenForSub('user-a'), refreshToken: 'r1' })
    const provider = createPushedRuntimeAuthProvider(() => pushed)
    await expect(provider.getAuth()).resolves.toMatchObject({ userId: 'user-a', refreshToken: 'r1' })
    pushed = runtimeAuthFromSupabaseTokens({ accessToken: tokenForSub('user-b'), refreshToken: 'r2' })
    await expect(provider.getAuth()).resolves.toMatchObject({ userId: 'user-b', refreshToken: 'r2' })
  })

  test('还没收到过推送(冷启动)与登出了,都答没登录', async () => {
    let pushed: PushedRuntimeAuth = undefined
    const provider = createPushedRuntimeAuthProvider(() => pushed)
    await expect(provider.getAuth()).resolves.toBeNull()
    pushed = null
    await expect(provider.getAuth()).resolves.toBeNull()
  })

  test('会话永久丢了:抛带类型的错(宿主据此发一次性信号),❌ 当成普通的没登录', async () => {
    const provider = createPushedRuntimeAuthProvider(() => 'lost')
    await expect(provider.getAuth()).rejects.toBeInstanceOf(RuntimeAuthExpiredError)
  })
})
