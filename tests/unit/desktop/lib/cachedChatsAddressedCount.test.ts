// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatUnreadLocator } from '@gugu/core/shared/types/chat'
import { shouldNotifyForChat } from '@gugu/core/shared/ui/chatNotificationModels'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, replaceChatRows } from '../../../../apps/desktop/src/lib/imRepository'
import { readCompleteCachedChats } from '../../../../apps/desktop/src/lib/chatSnapshotPublication'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { advanceReadWatermark } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { chat } from '../../../support/testHarness'

// 升级那一下:旧版客户端落盘的未读定位没有 addressed_count。拿它当「上一版」去比,话题的「叫到你」从 0 跳到真值,
// 每个这样的话题各弹一条假通知 —— 所以这份冷启缓存不算完整,整份作废(冷启首载不弹通知)。
const locator = (unread: number, addressed?: number): ChatUnreadLocator => ({
  stream_id: 'main:topic', stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
  unread_count: unread, cursor_seq: 0, version: 1, is_marked_unread: false,
  ...(addressed === undefined ? {} : { addressed_count: addressed }),
}) as ChatUnreadLocator
const topic = (unread: number, addressed?: number): ChatItem =>
  chat({ id: 'topic', kind: 'topic', source_chat_id: 'project', unread_count: unread, unread_locator: locator(unread, addressed) })

describe('cold-start cache written before addressed_count', () => {
  beforeEach(() => window.localStorage.clear())

  it('the comparison it would feed is exactly the false notification', () => {
    const on = { activeChatId: null, notificationsEnabled: true }
    expect(shouldNotifyForChat(topic(5), topic(5, 2), on)).toBe(true)
  })

  it('is not complete, so the first load starts cold instead of comparing against it', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await replaceChatRows(repository, [topic(5)])
    expect(readCompleteCachedChats(repository)).toEqual([])
    await replaceChatRows(repository, [topic(5, 2)])
    expect(readCompleteCachedChats(repository).map((row) => row.unread_locator?.addressed_count)).toEqual([2])
  })
})

describe('a failed mark-read puts the topic locator back', () => {
  it('so the project row does not lose the addressed count until the next refresh', async () => {
    let fail!: (error: Error) => void
    const spy = vi.spyOn(chatService, 'markRead').mockReturnValue(new Promise((_, reject) => { fail = reject }))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const before = { ...topic(5, 2), last_read_seq: 0, next_message_seq: 6 }
    const patches: Array<Partial<ChatItem>> = []
    advanceReadWatermark([before], 'topic', 5, (_id, partial) => { patches.push(partial) })
    expect(patches.at(-1)).toMatchObject({ unread_count: 0, unread_locator: null })
    fail(new Error('offline'))
    await Promise.resolve(); await Promise.resolve()
    expect(patches.at(-1)).toMatchObject({ unread_count: 5, unread_locator: before.unread_locator })
    spy.mockRestore()
  })
})
