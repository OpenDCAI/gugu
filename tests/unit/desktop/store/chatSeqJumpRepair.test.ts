// @vitest-environment jsdom
// @@@4439 — 跳号修复卫星的窄回归:post-commit 重判(剔除自身/同 tick 假阳性)、空窗直重载、
// 一页 delta + 整页 degrade、失败降级链。窗口摄入的端到端行为由 e2e/chat-inbound-render-4439.spec.ts(#6270 已删) 守。
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { NEWER_PAGE } from '../../../../apps/desktop/src/store/chatMessageWindow'
import { repairSeqJumpAfterIngest, type SeqJumpRepairIo } from '../../../../apps/desktop/src/store/chatSeqJumpRepair'

function row(id: string, seq: number): MessageItem {
  return {
    id,
    chat_id: 'chat-1',
    sender_user_id: 'peer-1',
    to_user_ids: ['user-1'],
    is_whisper: false,
    seq,
    content: `m${seq}`,
    content_type: 'text',
    reply_to_message_id: null,
    thread_root_id: null,
    is_thread_root: false,
    retracted_at: null,
    created_at: '2026-08-29T00:00:00.000Z',
    reactions: [],
    is_mine: false,
    delivered: true,
    delivery_status: null,
    local_send_state: null,
  }
}

function harness(windowRows: MessageItem[]) {
  const applyMessagesSnapshot = vi.fn<SeqJumpRepairIo['applyMessagesSnapshot']>()
  const refreshMessages = vi.fn<SeqJumpRepairIo['refreshMessages']>(async () => {})
  const io: SeqJumpRepairIo = {
    userId: () => 'user-1',
    windowRows: () => windowRows,
    snapshotEpoch: () => 7,
    revalidateInFlight: new Set<string>(),
    applyMessagesSnapshot,
    refreshMessages,
    revalidateWindowOverlays: vi.fn(async () => {}),
  }
  return { io, applyMessagesSnapshot, refreshMessages }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('repairSeqJumpAfterIngest', () => {
  it('reverifies the jumped range from the post-commit tail (excluding the ingested row itself)', async () => {
    const inbound = row('inbound', 41)
    vi.spyOn(chatService, 'getMessages').mockResolvedValue([inbound, row('acked', 42)])
    vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockResolvedValue({})
    const h = harness([row('tail', 40), row('acked', 42)]) // commit 后窗口:尾 40,acked 42 ⇒ 41 是洞

    await repairSeqJumpAfterIngest(h.io, row('acked', 42))

    expect(chatService.getMessages).toHaveBeenCalledWith('chat-1', 'user-1', 'loadNewer', NEWER_PAGE, undefined, 40)
    expect(h.applyMessagesSnapshot).toHaveBeenCalledWith('chat-1', [inbound, row('acked', 42)], {}, 7)
    expect(h.refreshMessages).not.toHaveBeenCalled()
  })

  it('self-cancels when the post-commit window is already contiguous (same-tick false positive)', async () => {
    const getMessages = vi.spyOn(chatService, 'getMessages')
    const h = harness([row('prev', 41), row('acked', 42)]) // 剔除自身后尾=41,42 无跳号

    await repairSeqJumpAfterIngest(h.io, row('acked', 42))

    expect(getMessages).not.toHaveBeenCalled()
    expect(h.refreshMessages).not.toHaveBeenCalled()
  })

  it('does not fire for the first-ever message (seq is 1-based, nothing skippable below 1)', async () => {
    const getMessages = vi.spyOn(chatService, 'getMessages')
    const h = harness([row('first', 1)])

    await repairSeqJumpAfterIngest(h.io, row('first', 1))

    expect(getMessages).not.toHaveBeenCalled()
    expect(h.refreshMessages).not.toHaveBeenCalled()
  })

  it('reloads authoritatively instead of paging from 0 when there is no verified tail', async () => {
    const getMessages = vi.spyOn(chatService, 'getMessages')
    const h = harness([row('acked', 5)]) // 剔除自身后窗口为空:恢复投递到本次未打开的会话的形态

    await repairSeqJumpAfterIngest(h.io, row('acked', 5))

    expect(h.refreshMessages).toHaveBeenCalledTimes(1)
    expect(getMessages).not.toHaveBeenCalled() // ❌ 不从 0 正序拉最老一页
  })

  it('degrades a full delta page to the authoritative reload', async () => {
    const fullPage = Array.from({ length: NEWER_PAGE }, (_, i) => row(`m${i}`, 41 + i))
    vi.spyOn(chatService, 'getMessages').mockResolvedValue(fullPage)
    vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockResolvedValue({})
    const h = harness([row('tail', 40), row('acked', 500)])

    await repairSeqJumpAfterIngest(h.io, row('acked', 500))

    expect(h.applyMessagesSnapshot).toHaveBeenCalledTimes(1)
    expect(h.refreshMessages).toHaveBeenCalledTimes(1) // 整页 ⇒ delta 覆盖不保证到尾 ⇒ 权威重载
  })

  it('falls back to the authoritative reload when the delta fetch fails, and stays loud on double failure', async () => {
    vi.spyOn(chatService, 'getMessages').mockRejectedValue(new Error('net down'))
    vi.spyOn(chatService, 'getOtherMembersReadSeqs').mockResolvedValue({})
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness([row('tail', 40), row('acked', 42)])
    h.refreshMessages.mockRejectedValue(new Error('still down'))

    await expect(repairSeqJumpAfterIngest(h.io, row('acked', 42))).resolves.toBeUndefined()

    expect(h.refreshMessages).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledTimes(2) // 两级失败各大声一次(rendererLogger web 退化 console)
  })
})
