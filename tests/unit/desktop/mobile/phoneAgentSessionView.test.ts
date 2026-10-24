import { describe, expect, it } from 'vitest'
import { phoneAgentSessionView } from '../../../../apps/desktop/src/mobile/local-agent/phoneAgentSessionView'
import type { PhoneAgentSession } from '../../../../apps/desktop/src/mobile/local-agent/nativeAgent'

const session: PhoneAgentSession = { agentUserId: 'agent', sessionId: 'session', displayName: 'Phone Agent', status: 'idle', chatId: 'dm', modelId: 'model' }
describe('phone agent session status uses real host/job signals', () => {
  it('never shows a saved working state as live after the native host disconnected or stopped', () => {
    expect(phoneAgentSessionView({ ...session, status: 'working' }, true, false)).toMatchObject({ label: '暂未连接', canCancel: false })
    expect(phoneAgentSessionView({ ...session, status: 'working' }, false, true)).toMatchObject({ label: '已停止', canCancel: false })
    expect(phoneAgentSessionView({ ...session, status: 'working' }, true, true)).toMatchObject({ label: '正在处理', canCancel: true })
  })
  it('distinguishes interrupted, failed, queued and cancelled tasks without parsing error prose', () => {
    expect(phoneAgentSessionView({ ...session, status: 'error', lastJobStatus: 'interrupted', lastError: '请先核对写入结果' }, true, true)).toEqual({ label: '上次任务已中断', detail: '请先核对写入结果', canCancel: false })
    expect(phoneAgentSessionView({ ...session, status: 'error', lastJobStatus: 'failed', lastError: '数据源中断' }, true, true).label).toBe('执行失败')
    expect(phoneAgentSessionView({ ...session, status: 'error', lastJobStatus: 'queued' }, true, true)).toMatchObject({ label: '等待处理', canCancel: true })
    expect(phoneAgentSessionView({ ...session, lastJobStatus: 'cancelled' }, true, true).label).toBe('任务已取消')
    expect(phoneAgentSessionView({ ...session, status: 'needs_user' }, true, true)).toMatchObject({ label: '等待确认', canCancel: false })
    expect(phoneAgentSessionView({ ...session, status: 'unexpected' }, true, true).label).toBe('状态未读取')
  })
})
