import { describe, expect, it, vi } from 'vitest'
import { runUnregister, UNREGISTERED_MARK, type UnregisterDeps } from '../../../../apps/desktop/electron/server/server-unregister'

// #6264 卸载时注销这台机器上的账号:从账号里移除这台机器 + 续期令牌作废 + 删本地登录态;网络不通也照删本地。
function deps(over: Partial<UnregisterDeps> = {}) {
  const lines: string[] = []
  const d: UnregisterDeps = {
    readSession: () => ({ accessToken: 'a', refreshToken: 'r' }),
    refresh: vi.fn(async () => 'fresh'),
    deviceId: vi.fn(async () => 'dev-1'),
    removeDevice: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
    clearLocal: vi.fn(),
    out: (line) => void lines.push(line),
    ...over,
  }
  return { d, lines }
}

describe('gugu-server unregister', () => {
  it('换到新令牌 → 移除这台机器 → 注销 → 删本地', async () => {
    const { d, lines } = deps()
    expect(await runUnregister(d)).toBe('removed')
    expect(d.removeDevice).toHaveBeenCalledWith('fresh', 'dev-1')
    expect(d.revoke).toHaveBeenCalledWith('fresh')
    expect(d.clearLocal).toHaveBeenCalledOnce()
    expect(lines).toEqual([`${UNREGISTERED_MARK} removed`])
  })

  it('库拒了移除(绑着智能体)⇒ 只注销;换不到令牌(已失效 / 没网)⇒ 只删本地', async () => {
    const refused = deps({ removeDevice: vi.fn(async () => { throw new Error('DEVICE_HAS_AGENTS') }) })
    expect(await runUnregister(refused.d)).toBe('revoked')
    const offline = deps({ refresh: vi.fn(async () => { throw new Error('ENOTFOUND') }) })
    expect(await runUnregister(offline.d)).toBe('local')
    expect(offline.d.clearLocal).toHaveBeenCalledOnce()
  })

  it('没登录态:什么都不做', async () => {
    const { d, lines } = deps({ readSession: () => null })
    expect(await runUnregister(d)).toBe('none')
    expect(lines).toEqual([])
  })
})
