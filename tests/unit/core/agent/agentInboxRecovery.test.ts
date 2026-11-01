import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pullAgentInbox, resetAgentInboxReaderStateForTests, type AgentInboxReaderDeps, type AgentInboxUnreadRow } from '@gugu/core/local/agent/agentInboxReader'
import { memoryGroupRulesLedger } from '@gugu/core/local/agent/groupRulesDelivery'

const AGENT = '00000000-0000-4000-8000-000000000001'
const CHAT = '00000000-0000-4000-8000-000000000002'
const MESSAGE = '00000000-0000-4000-8000-000000000003'
const HUMAN = '00000000-0000-4000-8000-000000000004'

function inbox(overrides: Partial<AgentInboxUnreadRow> = {}) {
  const row: AgentInboxUnreadRow = {
    chatId: CHAT, chatKind: 'group', groupRules: '', chatPublicId: 123, chatName: 'Test group', chatCreatorUserId: HUMAN,
    listenMode: 'active', notificationLevel: 'all', lastReadSeq: 0, id: MESSAGE, seq: 1,
    senderUserId: HUMAN, senderType: 'human', senderDisplayName: 'Sender', senderGuguNumber: null,
    content: 'Please read this message', contentType: 'text', toUserIds: null, isWhisper: false,
    replyToMessageId: null, replyToSenderUserId: null, replyToContent: null, threadRootId: null,
    isThreadRoot: false, createdAt: '2026-10-29T00:00:00Z', ...overrides,
  }
  let read = false
  const inject = vi.fn<AgentInboxReaderDeps['inject']>(async () => 'accepted')
  const postDisclosure = vi.fn<NonNullable<AgentInboxReaderDeps['postDisclosure']>>(async () => {})
  const deps: AgentInboxReaderDeps = {
    accessToken: 'test-token', inject, postDisclosure,
    fetchUnread: vi.fn(async () => read ? [] : [row]),
    markRead: vi.fn(async () => { read = true }),
    groupRulesLedger: memoryGroupRulesLedger(),
    agentSpokeAfter: async () => false,
  }
  return { deps, row, inject, postDisclosure }
}

beforeEach(() => { resetAgentInboxReaderStateForTests(); vi.useFakeTimers() })
afterEach(() => { resetAgentInboxReaderStateForTests(); vi.useRealTimers() })

describe('inbox recovery without another incoming message', () => {
  it('immediately admits image text and its folder link after one download failure, without a disclosure or second download', async () => {
    const { deps, inject, postDisclosure } = inbox({
      content: '[附件] screen.png (image/png)\n[Size] 3\n[Kind] image\n[Caption]\nPlease explain the screenshot',
      contentType: 'image', fileItemId: 'image-item', fileVersion: 2,
    })
    deps.downloadAttachment = vi.fn(async () => { throw new Error('download HTTP 503') })
    const started = Date.now()
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1, verdict: 'accepted' })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('Please explain the screenshot') }))
    expect(inject.mock.calls[0]![0].text).toContain('[Image not saved: download HTTP 503]')
    expect(inject.mock.calls[0]![0].text).toContain('gugu-file://image-item?v=2')
    expect(inject.mock.calls[0]![0].attachments).toBeUndefined()
    expect(deps.downloadAttachment).toHaveBeenCalledTimes(1)
    expect(postDisclosure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('retries a failed unread batch with backoff, then stops after acceptance without any new message', async () => {
    const { deps, inject } = inbox()
    inject.mockRejectedValueOnce(new Error('provider temporarily unavailable'))
      .mockRejectedValueOnce(new Error('provider temporarily unavailable'))
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('provider temporarily unavailable')
    expect(deps.markRead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(999)
    expect(inject).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(inject).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1999)
    expect(inject).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(inject).toHaveBeenCalledTimes(3)
    expect(deps.markRead).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(inject).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending retry after an external pull succeeds', async () => {
    const { deps, inject } = inbox()
    inject.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow()
    await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ injected: 1 })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(inject).toHaveBeenCalledTimes(2)
  })

  it('also retries a cloud read failure and caps consecutive failure backoff at one minute', async () => {
    const { deps, inject } = inbox()
    const read = deps.fetchUnread!
    deps.fetchUnread = vi.fn().mockRejectedValue(new Error('cloud temporarily unavailable'))
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('cloud temporarily unavailable')
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]) {
      const before = vi.mocked(deps.fetchUnread).mock.calls.length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(deps.fetchUnread).toHaveBeenCalledTimes(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(deps.fetchUnread).toHaveBeenCalledTimes(before + 1)
    }
    deps.fetchUnread = read
    await vi.advanceTimersByTimeAsync(60_000)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('stops a pending retry when the recipient is archived', async () => {
    const { deps, inject } = inbox()
    inject.mockRejectedValueOnce(new Error('temporarily unavailable'))
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow()
    deps.sessionArchival = () => ({ sessionId: 'session', revision: 1, archivedAt: '2026-10-29T01:00:00Z', intervals: [] })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('re-pulls only unread rows after a later admission fails in the same batch', async () => {
    const { deps, row, inject } = inbox()
    const later = { ...row, id: '00000000-0000-4000-8000-000000000005', seq: 2, content: 'Second message' }
    const read = new Set<string>()
    deps.fetchUnread = async () => [row, later].filter(entry => !read.has(entry.id))
    deps.markRead = async input => { read.add(input.messageId) }
    inject.mockResolvedValueOnce('accepted').mockRejectedValueOnce(new Error('temporary second admission failure'))
    await expect(pullAgentInbox(AGENT, deps)).rejects.toThrow('temporary second admission failure')
    await vi.advanceTimersByTimeAsync(1000)
    expect(inject.mock.calls.map(([input]) => input.messageId)).toEqual([MESSAGE, later.id, later.id])
    expect(read).toEqual(new Set([MESSAGE, later.id]))
  })

  it('does not retry a failed provider completion whose input was already accepted', async () => {
    const { deps, inject } = inbox()
    let fail!: (error: Error) => void
    inject.mockResolvedValueOnce({ verdict: 'accepted', completion: new Promise<void>((_, reject) => { fail = reject }) })
    const result = await pullAgentInbox(AGENT, deps)
    const settled = expect(result.completion).rejects.toThrow('provider turn failed')
    fail(new Error('provider turn failed'))
    await settled
    await vi.advanceTimersByTimeAsync(120_000)
    expect(inject).toHaveBeenCalledTimes(1)
    expect(deps.markRead).toHaveBeenCalledTimes(1)
  })

  it('does not poll normal not-live or not-now admission states', async () => {
    for (const verdict of ['not-live', 'not-now'] as const) {
      const { deps, inject } = inbox()
      inject.mockResolvedValue(verdict)
      await expect(pullAgentInbox(AGENT, deps)).resolves.toMatchObject({ verdict })
      await vi.advanceTimersByTimeAsync(120_000)
      expect(inject).toHaveBeenCalledTimes(1)
    }
  })
})
