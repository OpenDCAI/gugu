import type { ChatFileRef } from '@shared/extensions/app-files-core';
// #7199 桌面:主进程读聊天文件夹里一个文件此刻的文本(读法在 @shared/extensions/chat-folder-text)。令牌与文件服务都在这边;
// 网关没合 CORS 的库(devdb / 生产,gugu-supabase #119 之前)窗口里 fetch 会被预检挡住,桌面走这里不受影响。
import { userIdFromSupabaseAccessToken } from '@gugu/core';
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase';
import { currentAccountAccessToken } from '@main/core/extensions/account-token';
import { fileServiceUrl } from '@main/core/extensions/file-sync';
import { CHAT_FOLDER_ITEM_COLUMNS, readChatFolderTextWith, type ChatFolderText } from '@shared/extensions/chat-folder-text';

export function readChatFolderText(ref: ChatFileRef): Promise<ChatFolderText | null> {
  return readChatFolderTextWith(
    {
      async token() {
        const token = await currentAccountAccessToken();
        return token && userIdFromSupabaseAccessToken(token) ? token : null;
      },
      async find(token, file) {
        const query = createGuguSupabaseClient({ schema: 'chat', headers: { Authorization: `Bearer ${token}` } })
          .from('workspace_items')
          .select(CHAT_FOLDER_ITEM_COLUMNS);
        const found = 'id' in file ? query.eq('id', file.id) : query.eq('chat_id', file.chat).eq('filename', file.name).order('updated_at', { ascending: false });
        const { data, error } = await found.limit(1);
        return { data: data as { id: string; kind: string; updated_at: string }[] | null, error };
      },
      filesUrl: fileServiceUrl,
      fetch: (...args) => fetch(...args),
    },
    ref
  );
}
