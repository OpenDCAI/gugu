import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))
import { storedAgentRecoveries, storedAgentTurnFailures } from '../../../../apps/desktop/src/lib/storedAgentTurnFailures'

const row = (id: string, agent = 'agent', status = 'error', extra = {}) => ({ id, payload: { agent_user_id: agent }, status, error: 'weekly limit reached', completed_at: '2026-10-19T08:00:00Z', ...extra })
describe('持久投递结果在其他设备上的投影', () => {
  it('后来的成功/重试盖掉同一Agent的旧失败', () => {
    expect(storedAgentTurnFailures([row('new', 'agent', 'done'), row('old')], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('new', 'agent', 'pending'), row('old')], ['agent'])).toEqual([])
  })
  it('其他Agent的成功不会清掉这一位的失败，且忽略不在当前成员里的Agent', () => {
    expect(storedAgentTurnFailures([row('foreign', 'x'), row('ok', 'other', 'done'), row('failed')], ['agent', 'other']).map((failure) => failure.commandId)).toEqual(['failed'])
  })
  it('已在聊天披露的失败不再叠通知', () => {
    expect(storedAgentTurnFailures([row('failed', 'agent', 'error', { result: { reply_notice: 'in-chat' } })], ['agent'])).toEqual([])
  })
  it('旧宿主补明确额度原因；未标记的旧通用错误不重复披露', () => {
    expect(storedAgentTurnFailures([row('quota')], ['agent'])).toHaveLength(1)
    expect(storedAgentTurnFailures([row('old', 'agent', 'error', { error: 'failed batch' })], ['agent'])).toEqual([])
    expect(storedAgentTurnFailures([row('new', 'agent', 'error', { error: 'failed batch', result: { reply_notice: 'context' } })], ['agent'])).toHaveLength(1)
  })
  it('只有最新一次投递成功才算恢复', () => {
    expect(storedAgentRecoveries([row('new', 'agent', 'done'), row('old')], ['agent', 'other'])).toEqual(['agent'])
    expect(storedAgentRecoveries([row('new', 'agent', 'pending'), row('old', 'agent', 'done'), row('x', 'other', 'error')], ['agent', 'other'])).toEqual([])
  })
})
