import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../../store/chatContext'

/**
 * What people call a chat's folder (the preinstalled workspace App; code keeps saying workspace). owner 10-11: 「私聊就叫做文件夹吧，
 * 群里面是群文件夹」 — a group's is 群文件夹, any other chat's 文件夹, and a topic goes by the chat it grew out of. The one place
 * the name branches; the workspace App reads the same rule from `ctx.chat.groupId`.
 */
export function chatFolderNameKey(chatId: string | null, chats: readonly ChatItem[]): 'header.groupFolder' | 'header.folder' {
  return chatFolderNameKeyOf(chatId, (id) => chats.find((row) => row.id === id) ?? null)
}

/** The same rule over any way of reading a chat (the session page reads the shell's chat summaries). */
export function chatFolderNameKeyOf(chatId: string | null, chatOf: (id: string) => { kind: string | null; source_chat_id?: string | null } | null): 'header.groupFolder' | 'header.folder' {
  const chat = chatId ? chatOf(chatId) : null
  const place = chat?.kind === 'topic' && chat.source_chat_id ? chatOf(chat.source_chat_id) : chat
  return place?.kind === 'group' ? 'header.groupFolder' : 'header.folder'
}

export function useChatFolderName(chatId: string | null): string {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  return t(chatFolderNameKey(chatId, chats))
}
