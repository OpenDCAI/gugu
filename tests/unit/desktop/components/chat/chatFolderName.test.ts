// owner 10-11「私聊就叫做文件夹吧，群里面是群文件夹」:群的文件夹叫群文件夹,别的对话叫文件夹;话题跟它长出来的那个对话走。
// 名字只在 chatFolderNameKey 分一次,页头按钮、⋯ 菜单、面板标题都调它。对照(55ffebac2):处处「群文件夹」。
import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../../../packages/core/src/shared/types/chat'
import { chatFolderNameKey } from '../../../../../apps/desktop/src/components/chat/chatFolderName'

const chat = (id: string, kind: ChatItem['kind'], source_chat_id: string | null = null) => ({ id, kind, source_chat_id }) as ChatItem
const chats = [chat('g', 'group'), chat('d', 'dm'), chat('a', 'ai'), chat('tg', 'topic', 'g'), chat('td', 'topic', 'd')]

describe('chatFolderNameKey', () => {
  it.each([
    ['g', 'header.groupFolder'],
    ['tg', 'header.groupFolder'],
    ['d', 'header.folder'],
    ['td', 'header.folder'],
    ['a', 'header.folder'],
  ])('%s → %s', (id, key) => {
    expect(chatFolderNameKey(id, chats)).toBe(key)
  })
})
