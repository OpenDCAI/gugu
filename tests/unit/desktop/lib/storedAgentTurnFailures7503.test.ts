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
  it('说宿主落的原因码，不读原文', () => {
    expect(storedAgentTurnFailures([row('failed')], ['agent'])).toEqual([
      { agentUserId: 'agent', commandId: 'failed', reason: 'weeklyQuota', at: Date.parse('2026-10-19T08:00:00Z'), revision: '2026-10-19T08:00:00Z' },
    ])
  })
  it('已在聊天披露的失败由聊天说，这一槽不再说', () => {
    expect(storedAgentTurnFailures([row('failed', 'agent', 'error', { result: { reply_notice: 'in-chat', reason: 'generic' } })], ['agent'])).toEqual([])
  })
  it('没记原因的旧宿主行与认不出的原因不显示', () => {
    expect(storedAgentTurnFailures([row('old', 'agent', 'error', { result: { reply_notice: 'context' } })], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('old', 'agent', 'error', { result: null, error: 'weekly limit reached' })], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('odd', 'agent', 'error', { result: { reply_notice: 'context', reason: 'notYetKnown' } })], ['agent'])).toEqual([])
  })
  it('只有最新一次投递成功才算恢复', () => {
    expect(storedAgentRecoveries([row('new', 'agent', 'done'), row('old')], ['agent', 'other'])).toEqual(['agent'])
    expect(storedAgentRecoveries([row('new', 'agent', 'pending'), row('old', 'agent', 'done'), row('x', 'other', 'error')], ['agent', 'other'])).toEqual([])
  })
})
