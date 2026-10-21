// #7408 认出了是谁、通讯录却没读成(里头没有它):咕咕那一页说读不到,❌ 一直「正在读你的咕咕是谁」。
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))
const { assistantIdentityState } = await import('../../../../apps/desktop/src/lib/myAssistant')

const known = { agentId: 'agent-1', loading: false, error: null }

describe('assistantIdentityState', () => {
  it('认出了是谁、通讯录读失败、里头没有它:读不到', () => {
    expect(assistantIdentityState(false, known, 'error')).toBe('unreadable')
  })

  it('对照:通讯录还在读 / 读好了只是还没跟上:正在读', () => {
    expect(assistantIdentityState(false, known, 'loading')).toBe('loading')
    expect(assistantIdentityState(false, known, 'ready')).toBe('loading')
  })

  it('通讯录里有它:认到了(通讯录这一轮刷新失败也不影响)', () => {
    expect(assistantIdentityState(true, known, 'error')).toBe('found')
  })

  it('库里的标记读失败:读不到;库里没有:还没有', () => {
    expect(assistantIdentityState(false, { agentId: null, loading: false, error: 'boom' }, 'ready')).toBe('unreadable')
    expect(assistantIdentityState(false, { agentId: null, loading: false, error: null }, 'ready')).toBe('none')
  })
})
