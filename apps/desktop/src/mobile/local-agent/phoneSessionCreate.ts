import type { SessionpageSessionCreateRequest } from '@gugu/session-core/session-record/contract'
import { forgetPhoneAgentCreateAttempt, readPhoneAgentCreateAttempt } from './phoneAgentCreate'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const key = (ownerId: string, deviceId: string) => `gugu:phone-session-create:v1:${ownerId}:${deviceId}`

/** A lost creation reply must reuse the same intent, even after leaving the shared composer. */
export function readPhoneSessionCreate(ownerId: string, deviceId: string, storage: StorageLike = window.localStorage): SessionpageSessionCreateRequest | null {
  const raw = storage.getItem(key(ownerId, deviceId))
  if (raw) {
    const request = JSON.parse(raw) as SessionpageSessionCreateRequest
    if (!request.clientRequestId || !request.prompt?.trim() || request.harness !== 'pi') throw new Error('上次创建记录不完整，请保留记录后重试')
    return request
  }
  const previous = readPhoneAgentCreateAttempt(ownerId, deviceId, storage)
  return previous ? { clientRequestId: previous.id, title: previous.name.trim(), harness: 'pi', prompt: previous.prompt.trim(), model: previous.model, sessionView: 'general', ...(previous.chatId ? { chatId: previous.chatId } : {}) } : null
}

export function rememberPhoneSessionCreate(ownerId: string, deviceId: string, request: SessionpageSessionCreateRequest, storage: StorageLike = window.localStorage): void {
  const existing = readPhoneSessionCreate(ownerId, deviceId, storage)
  if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error('上次创建尚未确认，请先继续同一次创建')
  storage.setItem(key(ownerId, deviceId), JSON.stringify(request))
}

export function forgetPhoneSessionCreate(ownerId: string, deviceId: string, request: SessionpageSessionCreateRequest, storage: StorageLike = window.localStorage): void {
  const existing = readPhoneSessionCreate(ownerId, deviceId, storage)
  if (existing?.clientRequestId !== request.clientRequestId) throw new Error('创建记录已经改变，请保留记录后重试')
  storage.removeItem(key(ownerId, deviceId))
  const previous = readPhoneAgentCreateAttempt(ownerId, deviceId, storage)
  if (previous && previous.id === request.clientRequestId) forgetPhoneAgentCreateAttempt(previous, storage)
}
