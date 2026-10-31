import { getCurrentAuthUserId } from '@/lib/supabase'
import { invokePhoneHost } from './phoneHostRpc'

export type StoredPhoneTaskSend = { version: 1; id: string; text: string }
export interface PhoneTaskComposer {
  getState(): { text: string; attachments?: readonly unknown[] }
  setText(text: string): void
}
/** Restore only an empty composer. New words or selected attachments always belong to the user. */
export function restorePhoneTaskDraft(composer: PhoneTaskComposer, text: string): boolean {
  const current = composer.getState()
  if (current.text.length || current.attachments?.length) return false
  composer.setText(text)
  return true
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const listeners = new Set<(key: string) => void>()
export const phoneTaskSendKey = (ownerId: string, deviceId: string, sessionId: string): string => `gugu:phone-task-send:v1:${ownerId}:${deviceId}:${sessionId}`

export function readPhoneTaskSend(ownerId: string, deviceId: string, sessionId: string, storage: StorageLike = window.localStorage): StoredPhoneTaskSend | null {
  const raw = storage.getItem(phoneTaskSendKey(ownerId, deviceId, sessionId))
  if (raw === null) return null
  let pending: Partial<StoredPhoneTaskSend> | null
  try { pending = JSON.parse(raw) as Partial<StoredPhoneTaskSend> | null }
  catch { throw new Error('上次任务发送记录不完整，请保留记录后重试') }
  if (!pending || pending.version !== 1 || typeof pending.id !== 'string' || !pending.id || typeof pending.text !== 'string' || !pending.text.trim()) throw new Error('上次任务发送记录不完整，请保留记录后重试')
  return pending as StoredPhoneTaskSend
}

export function subscribePhoneTaskSend(listener: (key: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const changed = (key: string) => { for (const listener of listeners) listener(key) }

/** Preserve an unacknowledged task input across reloads; a retry cannot admit it twice. */
export async function sendPhoneTaskText(deviceId: string, sessionId: string, text: string, invoke = invokePhoneHost, storage: StorageLike = window.localStorage): Promise<unknown> {
  const ownerId = await getCurrentAuthUserId()
  return sendOwnedPhoneTask(ownerId, deviceId, sessionId, text, invoke, storage)
}

/** An explicit retry confirms the saved admission without adding another optimistic user message. */
export async function retryPhoneTaskSend(ownerId: string, deviceId: string, sessionId: string, id: string, invoke = invokePhoneHost, storage: StorageLike = window.localStorage): Promise<unknown> {
  if (await getCurrentAuthUserId() !== ownerId) throw new Error('当前账号已改变，未重新发送原稿')
  const pending = readPhoneTaskSend(ownerId, deviceId, sessionId, storage)
  if (!pending || pending.id !== id) throw new Error('待确认原稿已改变，请查看当前任务后再试')
  return sendOwnedPhoneTask(ownerId, deviceId, sessionId, pending.text, invoke, storage)
}

async function sendOwnedPhoneTask(ownerId: string, deviceId: string, sessionId: string, text: string, invoke: typeof invokePhoneHost, storage: StorageLike): Promise<unknown> {
  const key = phoneTaskSendKey(ownerId, deviceId, sessionId)
  const pending = readPhoneTaskSend(ownerId, deviceId, sessionId, storage)
  const body = text.trim()
  if (!body) throw new Error('请填写任务内容')
  if (pending && pending.text !== body) throw new Error('上条任务尚未确认，请先重试原消息，再发送新的内容')
  const request: StoredPhoneTaskSend = pending ?? { version: 1, id: crypto.randomUUID(), text: body }
  if (!pending) { storage.setItem(key, JSON.stringify(request)); changed(key) }
  const result = await invoke<{ accepted?: unknown }>(deviceId, 'sessionTimeline.sessionSend', [{ conversationId: sessionId, text: request.text, clientRequestId: request.id }], request.id)
  if (result?.accepted !== true) throw new Error('手机尚未确认接收任务，请重试原消息')
  if (await getCurrentAuthUserId() === ownerId) {
    const current = storage.getItem(key)
    if (current && (JSON.parse(current) as StoredPhoneTaskSend).id === request.id) { storage.removeItem(key); changed(key) }
  }
  return result
}
