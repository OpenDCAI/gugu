import type { PhoneAgentSession } from './nativeAgent'

/** Status labels come from native session/job signals, never from translated error text. */
export function phoneAgentSessionView(session: PhoneAgentSession, hostEnabled: boolean, hostReady: boolean): { label: string; detail: string | null; canCancel: boolean } {
  if (!hostEnabled) return { label: '已停止', detail: session.lastError || '重新启用后，可以在原对话里继续。', canCancel: false }
  if (session.lastJobStatus === 'interrupted' || session.status === 'interrupted') return { label: '上次任务已中断', detail: session.lastError || '这轮执行的结果尚未确认，请检查结果后在对话里继续。', canCancel: false }
  if (!hostReady) return { label: '暂未连接', detail: session.lastError || null, canCancel: false }
  if (session.status === 'needs_user') return { label: '等待确认', detail: '请在它的咕咕对话里查看并回复确认。', canCancel: false }
  if (session.status === 'working' || session.status === 'running') return { label: '正在处理', detail: null, canCancel: true }
  if (session.status === 'queued' || session.lastJobStatus === 'queued') return { label: '等待处理', detail: null, canCancel: true }
  if (session.status === 'error' || session.status === 'failed' || session.lastJobStatus === 'failed') return { label: '执行失败', detail: session.lastError || null, canCancel: false }
  if (session.lastJobStatus === 'cancelled' || session.status === 'cancelled') return { label: '任务已取消', detail: null, canCancel: false }
  if (session.status === 'idle' || session.status === 'done') return { label: '等待任务', detail: null, canCancel: false }
  if (session.status === 'stopped' || session.status === 'offline') return { label: '已停止', detail: null, canCancel: false }
  return { label: '状态未读取', detail: null, canCancel: false }
}
