// @vitest-environment jsdom
// gugu-dev#181 ⑯:壳发给会话页的对话摘要(⌘K 面板按名字、最后一句搜对话和话题;「来自 X」写名字)。
// 名字与对话列表那一行同一个函数(chatDisplayName):私聊写对方,备注优先 —— 三处叫法一样。
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatSlotHost } from '../../../../apps/desktop/src/components/ChatSlotHost'
import { readChatSummary } from '../../../../apps/desktop/src/lib/chatSummariesBridge'
import { ChatStoreProvider } from '../../../../apps/desktop/src/store/chatContext'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatStore } from '../../../support/testHarness'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const chat = (fields: Partial<ChatItem>) => ({ last_message_at: '2026-10-23T00:00:00.000Z', ...fields }) as ChatItem

describe('the chat summaries the shell hands the session page', () => {
  it('names a DM by its peer, the alias first, and carries the last line and a topic’s source', async () => {
    const value = chatStore({
      chatsRead: true,
      identitiesById: { 'peer-1': { display_name: 'Wei Zhang' }, 'peer-2': { display_name: 'Jun' } } as never,
      chats: [
        chat({ id: 'dm-alias', kind: 'dm', peer_user_id: 'peer-1', peer_alias: '阿威', last_message_preview: '周四前对一下' }),
        chat({ id: 'dm-plain', kind: 'dm', peer_user_id: 'peer-2' }),
        chat({ id: 'topic-1', kind: 'topic', name: '登录页白屏', source_chat_id: 'group-1' }),
      ],
    })
    await act(async () => { root.render(createElement(ChatStoreProvider, { value }, createElement(ChatSlotHost, {} as never))) })
    expect(readChatSummary('dm-alias')).toMatchObject({ name: '阿威', kind: 'dm', lastMessagePreview: '周四前对一下', sourceChatId: null })
    expect(readChatSummary('dm-plain')?.name).toBe('Jun')
    expect(readChatSummary('topic-1')).toMatchObject({ name: '登录页白屏', kind: 'topic', sourceChatId: 'group-1' })
  })
})

it('publishes a group alias to quick open and delivery titles, and removes it when cleared', async () => {
  const render = async (alias: string | null) => {
    const value = chatStore({ chatsRead: true, chats: [chat({ id: 'group-alias', kind: 'group', name: 'Shared group', alias })] })
    await act(async () => { root.render(createElement(ChatStoreProvider, { value }, createElement(ChatSlotHost, {} as never))) })
  }
  await render('Private group')
  expect(readChatSummary('group-alias')).toMatchObject({ name: 'Private group', alias: 'Private group' })
  // Clearing an alias equal to the shared name must still publish the removal.
  await render('Shared group')
  expect(readChatSummary('group-alias')?.alias).toBe('Shared group')
  await render(null)
  expect(readChatSummary('group-alias')?.name).toBe('Shared group')
  expect(readChatSummary('group-alias')?.alias).toBeUndefined()
})
