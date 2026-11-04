import { SessionBootTasks } from '../../../../packages/core/src/shared/sessionBootTasks'
/**
 * #7225 拉收件箱那一脚是 fire-and-forget:登录态拿不到(含续期被拒的 RuntimeAuthExpiredError)时只记一行 warn,
 * ❌ 漏成「未处理的 Promise 拒绝」。云电脑实撞:server 的续期令牌作废后开机,开机扫对每个 agent 踢一脚,
 * getAuth() 第一次调用抛 RuntimeAuthExpiredError,日志里多一条 level 50。
 */
import { RuntimeAuthExpiredError } from '@gugu/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { kickInboxWhenAuthed } from '../../../../apps/desktop/electron/sessionpage/agent-inbox-kick'

const auth = { accessToken: 'token', userId: 'owner' }

describe('kickInboxWhenAuthed (#7225)', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  beforeEach(() => {
    unhandled.length = 0
    process.on('unhandledRejection', onUnhandled)
  })
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
  })

  // 调用方的姿势:`void` 掉、不等。拒绝要是漏出去,下一轮事件循环 unhandledRejection 就会收到它。
  const fireAndForget = async (input: Parameters<typeof kickInboxWhenAuthed>[0]) => {
    void kickInboxWhenAuthed(input)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  it('续期被拒(RuntimeAuthExpiredError):记一行 warn、不拉,没有未处理的拒绝', async () => {
    const warn = vi.fn()
    const kick = vi.fn()
    await fireAndForget({
      agentUserId: 'agent-1',
      trigger: 'boot-scan',
      getAuth: () => Promise.reject(new RuntimeAuthExpiredError('Supabase token refresh rejected (400): refresh_token_not_found')),
      kick,
      log: { warn },
    })
    expect(unhandled).toEqual([])
    expect(kick).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ agentUserId: 'agent-1', trigger: 'boot-scan', err: expect.stringContaining('RuntimeAuthExpiredError') }),
      'skip inbox kick: auth unavailable'
    )
  })

  it('登着、却在装依赖那一步抛了:同样收掉,但说清是拉的那一步,❌ 说成登录问题', async () => {
    const warn = vi.fn()
    await fireAndForget({
      agentUserId: 'agent-1',
      trigger: 'wake-complete',
      getAuth: async () => auth,
      kick: () => {
        throw new Error('bridge unavailable')
      },
      log: { warn },
    })
    expect(unhandled).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: 'Error: bridge unavailable' }), 'inbox kick failed')
  })

  it('没登录(null / 没有 provider):照旧只记一行「没登录」', async () => {
    const warn = vi.fn()
    const kick = vi.fn()
    await fireAndForget({ agentUserId: 'agent-1', trigger: 'boot-scan', getAuth: async () => null, kick, log: { warn } })
    await fireAndForget({ agentUserId: 'agent-1', trigger: 'boot-scan', getAuth: () => undefined, kick, log: { warn } })
    expect(kick).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'skip inbox kick: host is not authenticated')
  })

  it('阴控 —— 登着:拿这份登录态拉一次,什么都不记', async () => {
    const warn = vi.fn()
    const kick = vi.fn()
    await fireAndForget({ agentUserId: 'agent-1', trigger: 'boot-scan', getAuth: async () => auth, kick, log: { warn } })
    expect(kick).toHaveBeenCalledWith(auth)
    expect(warn).not.toHaveBeenCalled()
    expect(unhandled).toEqual([])
  })
  it('reports boot failure through the shared owner without rejecting startup', async () => {
    const tasks = new SessionBootTasks(vi.fn())
    await expect(kickInboxWhenAuthed({ agentUserId: 'bad-agent', trigger: 'boot-scan', getAuth: async () => auth,
      kick: () => { throw new Error('boot inbox refusal') }, log: { warn: vi.fn() },
      onFailure: error => tasks.record('inbox-wake', 'bad-agent', error),
    })).resolves.toBeUndefined()
    expect(tasks.snapshot()).toEqual([{ operation: 'inbox-wake', taskId: 'bad-agent', message: 'boot inbox refusal' }])
  })

})
