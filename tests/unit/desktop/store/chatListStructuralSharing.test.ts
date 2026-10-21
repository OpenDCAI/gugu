// @vitest-environment jsdom
// 会话列表落地的结构共享:一条会话变了只换它那一行。activeChat 的身份随之只在它自己变了时才变 ——
// 聊天面板里以 activeChat 为依赖的派生(成员资料表 → 每条气泡的 memo)就不会被别的会话的预览补丁打穿。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyFetchedChatList, createChatListProjectionLedger } from '../../../../apps/desktop/src/store/chatListProjection'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { chat } from '../../../support/testHarness'

let repository: AccountImRepository
beforeEach(async () => { repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() }) })
afterEach(() => repository.close())

describe('applyFetchedChatList 结构共享', () => {
  it('未变的行沿用内存里那一版对象,变了的那行换新', async () => {
    const current = [chat({ id: 'a' }), chat({ id: 'b' }), chat({ id: 'c' })]
    // 投影每批重拼全部行:内容相同、对象全新。
    const fetched = current.map((row) => row.id === 'b' ? { ...row, last_message_preview: 'new' } : { ...row })
    const next = await applyFetchedChatList(createChatListProjectionLedger(), repository, { fetched, identities: [] },
      { currentChats: current, activeChatId: 'a', revokeMissingActive: false })
    expect(next[0]).toBe(current[0])
    expect(next[2]).toBe(current[2])
    expect(next[1]).not.toBe(current[1])
    expect(next[1]).toMatchObject({ id: 'b', last_message_preview: 'new' })
  })

  it('整份没变 ⇒ 连数组都是原来那一个(setChats 不触发任何重渲)', async () => {
    const current = [chat({ id: 'a' }), chat({ id: 'b' })]
    const next = await applyFetchedChatList(createChatListProjectionLedger(), repository, { fetched: current.map((row) => ({ ...row })), identities: [] },
      { currentChats: current, activeChatId: null, revokeMissingActive: false })
    expect(next).toBe(current)
  })
})
