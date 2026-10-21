import { platform } from '../platform'
import { rpc } from '../session/renderer/lib/ipc'
import type { ChatFileRef } from '../session/shared/extensions/app-files-core';
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

export function readChatFolderText(ref: ChatFileRef): Promise<ChatFolderText | null> {
  if (platform.kind === 'electron') return rpc.extensions.readChatFolderText(ref).then((answer) => {
    if (!answer.success) throw new Error(answer.error)
    return answer.data
  })
  return readChatFolderTextWith(
    {
      token: async () => getRendererAccessToken(),
      async find(_token, file) {
        const query = chatDb
          .from('workspace_items')
          .select(CHAT_FOLDER_ITEM_COLUMNS)
        const found = 'id' in file ? query.eq('id', file.id) : query.eq('chat_id', file.chat).eq('filename', file.name).order('updated_at', { ascending: false })
        const { data, error } = await found.limit(1)
        return { data: data as { id: string; kind: string; updated_at: string }[] | null, error }
      },
      filesUrl: rendererFileServiceUrl,
      fetch: (...args) => fetch(...args),
    },
    ref,
  )
}
