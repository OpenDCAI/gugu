import type { PhoneAgentHostCall, PhoneAgentHostReply, PhoneAgentHostState } from './nativeAgent'

export interface PhoneAgentCreateAttempt {
  version: 1
  id: string
  ownerId: string
  deviceId: string
  name: string
  prompt: string
  model: string
  chatId?: string
}

export interface PhoneAgentCreated {
  sessionId: string
  agentUserId: string
  chatId?: string
  birthGroup?: { chatId: string; status: 'joined' | 'pending_approval' | 'failed'; error?: string }
}

type CreationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (ownerId: string, deviceId: string) => `gugu:phone-agent-create:v1:${ownerId}:${deviceId}`
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Preserve the same request and words after a lost reply; never create a second identity on retry. */
export function readPhoneAgentCreateAttempt(ownerId: string, deviceId: string, storage: CreationStorage = window.localStorage): PhoneAgentCreateAttempt | null {
  const raw = storage.getItem(storageKey(ownerId, deviceId))
  if (!raw) return null
  const value = JSON.parse(raw) as Partial<PhoneAgentCreateAttempt>
  if (value.version !== 1 || value.ownerId !== ownerId || value.deviceId !== deviceId
    || !text(value.id) || !text(value.name) || !text(value.prompt) || !text(value.model)
    || (value.chatId !== undefined && !text(value.chatId))) throw new Error('这台手机的创建记录不完整，请保留记录后重试')
  return value as PhoneAgentCreateAttempt
}

export function rememberPhoneAgentCreateAttempt(attempt: PhoneAgentCreateAttempt, storage: CreationStorage = window.localStorage): void {
  storage.setItem(storageKey(attempt.ownerId, attempt.deviceId), JSON.stringify(attempt))
}

export function forgetPhoneAgentCreateAttempt(attempt: PhoneAgentCreateAttempt, storage: CreationStorage = window.localStorage): void {
  const saved = readPhoneAgentCreateAttempt(attempt.ownerId, attempt.deviceId, storage)
  if (saved && saved.id !== attempt.id) throw new Error('手机创建记录已经改变，未删除新的记录')
  storage.removeItem(storageKey(attempt.ownerId, attempt.deviceId))
}

/** Both local creation and remote spawn run the Node host's one durable provision + birth-group saga. */
export async function createPhoneAgent(attempt: PhoneAgentCreateAttempt, host: PhoneAgentHostState | null, invoke: (input: PhoneAgentHostCall) => Promise<PhoneAgentHostReply>): Promise<PhoneAgentCreated> {
  if (!host?.ready || host.status !== 'ready' || host.ownerId !== attempt.ownerId || host.deviceId !== attempt.deviceId) throw new Error('这台手机尚未连接，暂时不能创建 Agent')
  if (!attempt.name.trim() || !attempt.prompt.trim()) throw new Error('请填写 Agent 名字和第一件任务')
  if (!attempt.model.startsWith('platform:') || !attempt.model.slice('platform:'.length)) throw new Error('请选择可用的咕咕模型')
  const reply = await invoke({ ownerId: attempt.ownerId, id: attempt.id, channel: 'sessionTimeline.sessionCreate', args: [{
    clientRequestId: attempt.id, title: attempt.name.trim(), harness: 'pi', sessionView: 'general', model: attempt.model,
    prompt: attempt.prompt.trim(), ...(attempt.chatId ? { chatId: attempt.chatId } : {}),
  }] })
  if (reply.error) throw new Error(reply.error.message)
  const result = reply.result as { conversationId?: unknown; agentUserId?: unknown; chatId?: unknown; birthGroup?: { chatId?: unknown; status?: unknown; error?: unknown } } | undefined
  if (!result || !text(result.conversationId) || !text(result.agentUserId)) throw new Error('手机尚未返回完整的 Agent 创建结果，请继续同一次创建')
  if (attempt.chatId && (result.birthGroup?.chatId !== attempt.chatId || !['joined', 'pending_approval', 'failed'].includes(String(result.birthGroup.status)))) throw new Error('Agent 的入群结果尚未确认，请继续同一次创建')
  return {
    sessionId: result.conversationId, agentUserId: result.agentUserId, ...(text(result.chatId) ? { chatId: result.chatId } : {}),
    ...(attempt.chatId ? { birthGroup: { chatId: attempt.chatId, status: result.birthGroup!.status as 'joined' | 'pending_approval' | 'failed', ...(text(result.birthGroup?.error) ? { error: result.birthGroup.error } : {}) } } : {}),
  }
}
