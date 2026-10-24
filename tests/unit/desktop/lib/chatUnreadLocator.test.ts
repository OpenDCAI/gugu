// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { openStreamAtLocator, type OpenableUnreadTarget } from '../../../../apps/desktop/src/lib/chatUnreadLocator'
import type { UnreadLocatorCommit } from '../../../../apps/desktop/src/lib/chatUnreadLocatorWindow'
import { findVisibleUnreadMessageRow } from '../../../../apps/desktop/src/hooks/useUnreadLocatorNavigation'

function giveVisibleRect(element: HTMLElement): void {
  const rect = {
    x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100,
    toJSON: () => ({}),
  } as DOMRect
  Object.defineProperty(element, 'getClientRects', { value: () => ({ 0: rect, length: 1, item: () => rect }) })
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => rect })
}

function unreadThreadChat(): ChatItem {
  return {
    id: 'chat-new',
    kind: 'group',
    status: 'active',
    name: 'Group',
    created_at: '2026-08-15T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 1,
    unread_locator: {
      stream_id: 'thread:chat-new:root-1',
      stream_kind: 'thread',
      thread_root_id: 'root-1',
      message_id: 'reply-1',
      message_seq: 51,
      unread_count: 1,
      cursor_seq: 0,
      version: 0,
      is_marked_unread: false,
    },
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: 52,
  }
}

describe('unread locator navigation', () => {
  it('confirms only a visible row inside the requested stream surface', () => {
    document.body.innerHTML = `
      <div data-unread-stream-surface="main"><div data-msg-id="same-id"></div></div>
      <div data-unread-stream-surface="thread" style="opacity: 0"><div data-msg-id="same-id"></div></div>
    `
    const mainSurface = document.querySelector<HTMLElement>('[data-unread-stream-surface="main"]')!
    const threadSurface = document.querySelector<HTMLElement>('[data-unread-stream-surface="thread"]')!
    const mainRow = mainSurface.querySelector<HTMLElement>('[data-msg-id]')!
    const threadRow = threadSurface.querySelector<HTMLElement>('[data-msg-id]')!
    for (const element of [mainSurface, threadSurface, mainRow, threadRow]) giveVisibleRect(element)

    expect(findVisibleUnreadMessageRow(mainSurface, 'same-id')).toBe(mainRow)
    expect(findVisibleUnreadMessageRow(threadSurface, 'same-id')).toBeNull()
    threadSurface.style.opacity = '1'
    expect(findVisibleUnreadMessageRow(threadSurface, 'same-id')).toBe(threadRow)
  })

  // @@@4258 — 水位提交的是 ensureMessageLoaded 交回的 commit.readSeq(本次真拉进行集的最大已落定 seq),
  // 不是 locator 自己的锚点 seq(51)。commit 报 54 时 markRead 必须发 54:锚点只说"从哪条开始未读"。
  it('activates the exact chat, then commits the loaded window seq rather than the locator seq', async () => {
    const steps: string[] = []
    const locator = unreadThreadChat().unread_locator!
    const target: OpenableUnreadTarget = {
      chatId: 'chat-new',
      locator: { ...locator, message_id: locator.message_id!, message_seq: locator.message_seq! },
    }
    const loadedWindow: UnreadLocatorCommit = { rows: [], readSeq: 54, reachedTail: true }
    await openStreamAtLocator(target, {
      activateChat: async (chatId) => { steps.push(`activate:${chatId}`) },
      ensureMessageLoaded: async (opened) => { steps.push(`load:${opened.locator.message_id}`); return loadedWindow },
      revealMessage: async (opened) => { steps.push(`reveal:${opened.locator.message_id}`) },
      markRead: async (opened, commit) => { steps.push(`read:${opened.locator.stream_id}:${commit.readSeq}`) },
      refreshChats: async () => { steps.push('refresh') },
    })
    expect(steps).toEqual([
      'activate:chat-new',
      'load:reply-1',
      'reveal:reply-1',
      'read:thread:chat-new:root-1:54',
      'refresh',
    ])
  })

  it.each(['load', 'reveal'] as const)('never clears the stream when %s fails', async (failure) => {
    const locator = unreadThreadChat().unread_locator!
    const target: OpenableUnreadTarget = {
      chatId: 'chat-new',
      locator: { ...locator, message_id: locator.message_id!, message_seq: locator.message_seq! },
    }
    let marked = false
    await expect(openStreamAtLocator(target, {
      activateChat: async () => {},
      ensureMessageLoaded: async () => {
        if (failure === 'load') throw new Error('not loaded')
        return { rows: [], readSeq: 51, reachedTail: true }
      },
      revealMessage: async () => { if (failure === 'reveal') throw new Error('not rendered') },
      markRead: async () => { marked = true },
      refreshChats: async () => {},
    })).rejects.toThrow(failure === 'load' ? 'not loaded' : 'not rendered')
    expect(marked).toBe(false)
  })
})
