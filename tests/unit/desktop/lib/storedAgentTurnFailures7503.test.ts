import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
import { storedAgentRecoveries, storedAgentTurnFailures } from '../../../../apps/desktop/src/lib/storedAgentTurnFailures'

const context = { reply_notice: 'context', reason: 'weeklyQuota' }
const row = (id: string, agent = 'agent', status = 'error', extra = {}) => ({ id, payload: { agent_user_id: agent }, status, result: context, completed_at: '2026-10-19T08:00:00Z', ...extra })
describe('持久投递结果在其他设备上的投影', () => {
  it('后来的成功/重试盖掉同一Agent的旧失败', () => {
    expect(storedAgentTurnFailures([row('new', 'agent', 'done'), row('old')], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('new', 'agent', 'pending'), row('old')], ['agent'])).toEqual([])
  })
  it('其他Agent的成功不会清掉这一位的失败，且忽略不在当前成员里的Agent', () => {
    expect(storedAgentTurnFailures([row('foreign', 'x'), row('ok', 'other', 'done'), row('failed')], ['agent', 'other']).map((failure) => failure.commandId)).toEqual(['failed'])
  })
  it('聊天范围:已离开的 Agent 只说它欠的未送达;任务页范围不说', () => {
    const rejected = row('gone', 'x', 'error', { result: { reply_notice: 'context', reason: 'deliveryRejected' } })
    expect(storedAgentTurnFailures([rejected], ['agent'], true)).toMatchObject([{ agentUserId: 'x', commandId: 'gone', reason: 'deliveryRejected', departed: true }])
    expect(storedAgentTurnFailures([rejected], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('quota', 'x')], ['agent'], true)).toEqual([])
    expect(storedAgentTurnFailures([rejected], ['x'], true)).toMatchObject([{ departed: false }])
  })
  it('说宿主落的原因码，不读原文', () => {
    expect(storedAgentTurnFailures([row('failed')], ['agent'])).toEqual([
      { agentUserId: 'agent', commandId: 'failed', reason: 'weeklyQuota', at: Date.parse('2026-10-19T08:00:00Z'), revision: '2026-10-19T08:00:00Z', departed: false },
    ])
  })
  it('已在聊天披露的失败由聊天说，这一槽不再说', () => {
    expect(storedAgentTurnFailures([row('failed', 'agent', 'error', { result: { reply_notice: 'in-chat', reason: 'generic' } })], ['agent'])).toEqual([])
  })
  it('认不出的原因不显示', () => {
    expect(storedAgentTurnFailures([row('odd', 'agent', 'error', { result: { reply_notice: 'context', reason: 'notYetKnown' } })], ['agent'])).toEqual([])
  })
  // 向下兼容一档(宿主 ≤ 0.3.1 不记 reason;0.3.3 随 olderHostReason 一起删)。
  it('旧宿主行:留给 composer 的按原文分类;额度类在聊天里写过或没标位置也照亮;在聊天里说过的别的失败不重复', () => {
    const old = (extra: object) => row('old', 'agent', 'error', extra)
    expect(storedAgentTurnFailures([old({ result: { reply_notice: 'context' }, error: 'fetch failed' })], ['agent'])).toMatchObject([{ reason: 'network' }])
    expect(storedAgentTurnFailures([old({ result: { reply_notice: 'in-chat' }, error: 'weekly limit reached' })], ['agent'])).toMatchObject([{ reason: 'weeklyQuota' }])
    expect(storedAgentTurnFailures([old({ result: null, error: 'weekly limit reached' })], ['agent'])).toMatchObject([{ reason: 'weeklyQuota' }])
    expect(storedAgentTurnFailures([old({ result: { reply_notice: 'in-chat' }, error: 'failed batch' })], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([old({ result: null, error: 'failed batch' })], ['agent'])).toEqual([])
    // The RPC projection names the key for every row; an old host's row has it null.
    expect(storedAgentTurnFailures([old({ result: { reply_notice: 'context', reason: null }, error: 'fetch failed' })], ['agent'])).toMatchObject([{ reason: 'network' }])
  })
  it('只有最新一次投递成功才算恢复', () => {
    expect(storedAgentRecoveries([row('new', 'agent', 'done'), row('old')], ['agent', 'other'])).toEqual(['agent'])
    expect(storedAgentRecoveries([row('new', 'agent', 'pending'), row('old', 'agent', 'done'), row('x', 'other', 'error')], ['agent', 'other'])).toEqual([])
  })
})
