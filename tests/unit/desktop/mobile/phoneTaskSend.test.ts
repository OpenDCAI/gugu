// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const auth = vi.hoisted(() => ({ owner: 'owner-a' }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => auth.owner }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/phoneHostRpc', () => ({ invokePhoneHost: vi.fn() }))
import { readPhoneTaskSend, retryPhoneTaskSend, sendPhoneTaskText } from '../../../../apps/desktop/src/mobile/local-agent/phoneTaskSend'

beforeEach(() => { localStorage.clear(); auth.owner = 'owner-a' })

describe('durable phone task admission', () => {
  it('reuses the same admission id after a lost acknowledgement and only clears on acceptance', async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({ accepted: true })
    await expect(sendPhoneTaskText('phone', 'task', ' hello ', invoke)).rejects.toThrow('connection lost')
    const request = invoke.mock.calls[0][2][0]
    expect(request).toMatchObject({ conversationId: 'task', text: 'hello', clientRequestId: expect.any(String) })
    expect(localStorage.length).toBe(1)
    await expect(sendPhoneTaskText('phone', 'task', 'hello', invoke)).resolves.toEqual({ accepted: true })
    expect(invoke.mock.calls[1]).toEqual(invoke.mock.calls[0])
    expect(localStorage.length).toBe(0)
  })

  it('does not admit a different input while the previous request is uncertain', async () => {
    const invoke = vi.fn().mockResolvedValue({ accepted: false })
    await expect(sendPhoneTaskText('phone', 'task', 'first', invoke)).rejects.toThrow('尚未确认')
    await expect(sendPhoneTaskText('phone', 'task', 'second', invoke)).rejects.toThrow('重试原消息')
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(localStorage.length).toBe(1)
  })

  it('isolates task/device/account outboxes and does not clear an old owner request after switching', async () => {
    let accept!: (value: { accepted: boolean }) => void
    const invoke = vi.fn().mockReturnValueOnce(new Promise((resolve) => { accept = resolve })).mockResolvedValue({ accepted: true })
    const old = sendPhoneTaskText('phone', 'task', 'old', invoke)
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    auth.owner = 'owner-b'
    await sendPhoneTaskText('phone', 'task', 'new', invoke)
    accept({ accepted: true })
    await old
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toContain('owner-a:phone:task')
    expect(invoke.mock.calls[1][2][0].clientRequestId).not.toBe(invoke.mock.calls[0][2][0].clientRequestId)
  })

  it('fails before sending if durable storage is unavailable', async () => {
    const invoke = vi.fn()
    const storage = { getItem: () => null, setItem: () => { throw new Error('quota') }, removeItem: vi.fn() }
    await expect(sendPhoneTaskText('phone', 'task', 'hello', invoke, storage)).rejects.toThrow('quota')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('exposes the scoped original and explicitly retries its same id without auto-admission', async () => {
    const first = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
    await expect(sendPhoneTaskText('phone', 'task', 'recover me', first)).rejects.toThrow()
    const saved = readPhoneTaskSend('owner-a', 'phone', 'task')!
    expect(saved.text).toBe('recover me')
    expect(readPhoneTaskSend('owner-b', 'phone', 'task')).toBeNull()
    expect(readPhoneTaskSend('owner-a', 'another-phone', 'task')).toBeNull()
    expect(readPhoneTaskSend('owner-a', 'phone', 'another-task')).toBeNull()
    const accepted = vi.fn().mockResolvedValue({ accepted: true })
    await retryPhoneTaskSend('owner-a', 'phone', 'task', saved.id, accepted)
    expect(accepted.mock.calls[0]).toEqual(first.mock.calls[0])
    expect(localStorage.length).toBe(0)
  })

  it('refuses a stale recovery after the account or pending request changed', async () => {
    const fail = vi.fn().mockRejectedValue(new Error('lost acknowledgement'))
    await expect(sendPhoneTaskText('phone', 'task', 'old', fail)).rejects.toThrow()
    const saved = readPhoneTaskSend('owner-a', 'phone', 'task')!
    const invoke = vi.fn()
    auth.owner = 'owner-b'
    await expect(retryPhoneTaskSend('owner-a', 'phone', 'task', saved.id, invoke)).rejects.toThrow('账号已改变')
    auth.owner = 'owner-a'
    await expect(retryPhoneTaskSend('owner-a', 'phone', 'task', 'replaced-id', invoke)).rejects.toThrow('原稿已改变')
    expect(invoke).not.toHaveBeenCalled()
    expect(readPhoneTaskSend('owner-a', 'phone', 'task')).toEqual(saved)
  })
})
