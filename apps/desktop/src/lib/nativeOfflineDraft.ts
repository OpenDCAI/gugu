import { state } from './sessionInputOutboxBridge'
const key = (deviceId: string | null, sessionId: string) => {
  const own = state()
  return own.valid() && own.accountId ? `gugu.native-offline-draft:${own.accountId}/${deviceId ?? 'local'}/${sessionId}` : null
}
export function readNativeOfflineDraft(deviceId: string | null, sessionId: string): string {
  const id = key(deviceId, sessionId)
  return id ? localStorage.getItem(id) ?? '' : ''
}
export function writeNativeOfflineDraft(deviceId: string | null, sessionId: string, text: string): void {
  const id = key(deviceId, sessionId)
  if (!id) throw new Error('当前账号的会话输入尚未就绪')
  if (text) localStorage.setItem(id, text)
  else localStorage.removeItem(id)
}
