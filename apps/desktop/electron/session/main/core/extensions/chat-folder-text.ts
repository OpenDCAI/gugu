// #7199 桌面:主进程读聊天文件夹里一个文件此刻的文本(读法在 @shared/extensions/chat-folder-text)。令牌与文件服务都在这边;
// 网关没合 CORS 的库(devdb / 生产,gugu-supabase #119 之前)窗口里 fetch 会被预检挡住,桌面走这里不受影响。
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { fileServiceUrl } from '@main/core/extensions/file-sync';
import { CHAT_FOLDER_ITEM_COLUMNS, readChatFolderTextWith, type ChatFolderText } from '@shared/extensions/chat-folder-text';

export function readChatFolderText(chatId: string, filename: string): Promise<ChatFolderText | null> {
  return readChatFolderTextWith(
    {
      async token() {
        const token = await currentAccountAccessToken();
        return token && userIdFromSupabaseAccessToken(token) ? token : null;
      },
      async latest(token, chat, name) {
        const { data, error } = await createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } })
          .from('workspace_items')
          .select(CHAT_FOLDER_ITEM_COLUMNS)
          .eq('chat_id', chat)
          .eq('filename', name)
          .order('updated_at', { ascending: false })
          .limit(1);
        return { data: data as { id: string; kind: string; updated_at: string }[] | null, error };
      },
      filesUrl: fileServiceUrl,
      fetch: (...args) => fetch(...args),
    },
    chatId,
    filename
  );
}
