import { describe, expect, it, vi } from 'vitest'
import { createPhoneAgent, forgetPhoneAgentCreateAttempt, readPhoneAgentCreateAttempt, rememberPhoneAgentCreateAttempt, type PhoneAgentCreateAttempt } from '../../../../apps/desktop/src/mobile/local-agent/phoneAgentCreate'
import type { PhoneAgentHostState } from '../../../../apps/desktop/src/mobile/local-agent/nativeAgent'

const host: PhoneAgentHostState = { ownerId: 'owner', deviceId: 'phone-owned', status: 'ready', ready: true, sessions: [] }
const attempt = (): PhoneAgentCreateAttempt => ({ version: 1, id: 'request-1', ownerId: 'owner', deviceId: 'phone-owned', name: ' 手机 Agent ', prompt: ' 查今天日程 ', model: 'platform:model-a' })
const reply = () => ({ result: { conversationId: 'session-1', agentUserId: 'agent-1', chatId: 'dm-1' } })
function memoryStorage() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

describe('phone creation delegates to the one native provision saga', () => {
  it.each([
    null,
    { ...host, ready: false, status: 'starting' as const },
    { ...host, ready: true, status: 'failed' as const },
    { ...host, ownerId: 'another-owner' },
    { ...host, deviceId: 'another-phone' },
  ])('refuses creation without the exact ready owner/device (%j)', async (state) => {
    const invoke = vi.fn()
    await expect(createPhoneAgent(attempt(), state, invoke)).rejects.toThrow('暂时不能创建')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes Pi, platform model, first task and the same client request id on a lost-reply retry', async () => {
    const invoke = vi.fn(async () => reply())
    const request = attempt()
    await expect(createPhoneAgent(request, host, invoke)).resolves.toEqual({ sessionId: 'session-1', agentUserId: 'agent-1', chatId: 'dm-1' })
    await createPhoneAgent(request, host, invoke)
    const expected = { ownerId: 'owner', id: 'request-1', channel: 'sessionTimeline.sessionCreate', args: [{ clientRequestId: 'request-1', title: '手机 Agent', harness: 'pi', sessionView: 'general', model: 'platform:model-a', prompt: '查今天日程' }] }
    expect(invoke.mock.calls).toEqual([[expected], [expected]])
  })

  it.each(['joined', 'pending_approval'] as const)('preserves the birth group and requires its authoritative %s result', async (status) => {
    const request = { ...attempt(), chatId: 'group-1' }
    const invoke = vi.fn(async () => ({ result: { ...reply().result, birthGroup: { chatId: 'group-1', status } } }))
    await expect(createPhoneAgent(request, host, invoke)).resolves.toMatchObject({ birthGroup: { chatId: 'group-1', status } })
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ args: [expect.objectContaining({ chatId: 'group-1' })] }))
    await expect(createPhoneAgent(request, host, async () => reply())).rejects.toThrow('入群结果尚未确认')
  })

  it('keeps an actually created Agent when joining the group failed, without retrying creation', async () => {
    const invoke = vi.fn(async () => ({ result: { ...reply().result, birthGroup: { chatId: 'group-1', status: 'failed', error: '群管理员未允许加入' } } }))
    await expect(createPhoneAgent({ ...attempt(), chatId: 'group-1' }, host, invoke)).resolves.toEqual({ sessionId: 'session-1', agentUserId: 'agent-1', chatId: 'dm-1', birthGroup: { chatId: 'group-1', status: 'failed', error: '群管理员未允许加入' } })
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('does not turn a command receipt or a native error into successful creation', async () => {
    await expect(createPhoneAgent(attempt(), host, async () => ({ result: { accepted: true } }))).rejects.toThrow('完整的 Agent 创建结果')
    await expect(createPhoneAgent(attempt(), host, async () => ({ error: { code: 'denied', message: '群管理员已拒绝' } }))).rejects.toThrow('群管理员已拒绝')
  })

  it('accepts a real task identity without assuming a private chat exists', async () => {
    await expect(createPhoneAgent(attempt(), host, async () => ({ result: { conversationId: 'session-1', agentUserId: 'agent-1' } }))).resolves.toEqual({ sessionId: 'session-1', agentUserId: 'agent-1' })
  })
})

describe('durable phone creation retry', () => {
  it('keeps identical words/group/id through a page reload and isolates the owner/device', () => {
    const storage = memoryStorage()
    const request = { ...attempt(), chatId: 'group-1' }
    rememberPhoneAgentCreateAttempt(request, storage)
    expect(readPhoneAgentCreateAttempt('owner', 'phone-owned', storage)).toEqual(request)
    expect(readPhoneAgentCreateAttempt('someone-else', 'phone-owned', storage)).toBeNull()
    expect(readPhoneAgentCreateAttempt('owner', 'different-phone', storage)).toBeNull()
    forgetPhoneAgentCreateAttempt(request, storage)
    expect(readPhoneAgentCreateAttempt('owner', 'phone-owned', storage)).toBeNull()
  })

  it('preserves corrupt or replaced retry records instead of losing their only idempotency key', () => {
    const storage = memoryStorage()
    const request = attempt()
    rememberPhoneAgentCreateAttempt(request, storage)
    const key = [...storage.values.keys()][0]!
    storage.values.set(key, '{broken')
    expect(() => readPhoneAgentCreateAttempt('owner', 'phone-owned', storage)).toThrow()
    expect(storage.values.get(key)).toBe('{broken')
    rememberPhoneAgentCreateAttempt({ ...request, id: 'a-new-request' }, storage)
    expect(() => forgetPhoneAgentCreateAttempt(request, storage)).toThrow('未删除新的记录')
    expect(readPhoneAgentCreateAttempt('owner', 'phone-owned', storage)?.id).toBe('a-new-request')
  })
})
