// #7199 手机 / 网页:窗口里读聊天文件夹里一个文件此刻的文本(读法在 session/shared/extensions/chat-folder-text.ts;
// 桌面在主进程读)。文件服务要答跨域预检(gugu-supabase #119)。
import { getSupabaseUrl } from '@gugu/core/cloud/config'
import { CHAT_FOLDER_ITEM_COLUMNS, readChatFolderTextWith, type ChatFolderText } from '../session/shared/extensions/chat-folder-text'
import { getRendererAccessToken } from './sessionPublication'
import { chatDb } from './supabase'

/** 窗口里文件服务在哪:`VITE_GUGU_FILES_URL`(本地栈),否则 `<supabase>/files`。手机壳的 App 宿主也用这一份。 */
export function rendererFileServiceUrl(): string {
  const configured = (import.meta.env.VITE_GUGU_FILES_URL as string | undefined)?.trim()
  return (configured || `${getSupabaseUrl().replace(/\/+$/, '')}/files`).replace(/\/+$/, '')
}

export function readChatFolderText(chatId: string, filename: string): Promise<ChatFolderText | null> {
  return readChatFolderTextWith(
    {
      token: async () => getRendererAccessToken(),
      async latest(_token, chat, name) {
        const { data, error } = await chatDb
          .from('workspace_items')
          .select(CHAT_FOLDER_ITEM_COLUMNS)
          .eq('chat_id', chat)
          .eq('filename', name)
          .order('updated_at', { ascending: false })
          .limit(1)
        return { data: data as { id: string; kind: string; updated_at: string }[] | null, error }
      },
      filesUrl: rendererFileServiceUrl,
      fetch: (...args) => fetch(...args),
    },
    chatId,
    filename,
  )
}
