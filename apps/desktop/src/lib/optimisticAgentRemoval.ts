import type { ChatItem } from '@gugu/core/shared/types/chat'

// @@@1877 删本机 Agent 成功后，会话列表(chat store)的即时乐观收敛。通讯录已靠 setContacts/setGroups 即时更新，
// 会话列表原先只能等末尾 async refreshChats(网络 refetch, 1–3s)兜底，期间仍显示已删 Agent 的 DM(带绿色在线点)。
// 这里复用 chat store 既有 API(不给 store god-file 加行)：
//  ① 直连该 Agent 的 DM(peer_user_id 命中)整行 deleteChat——deleteChat 会同步清掉 activeChatId(若正打开该 DM),
//     避免聊天区残留一个对端已删的幽灵会话;
//  ② 群聊行 patchChat 把该 Agent 从成员关系 id 剔除,让群行的聚合在线点/
//     头像合成立即收敛。
// 幂等、纯乐观；只在后端 remove_owned_agent 成功后调用，realtime/refetch 兜底同真值。
export interface ChatListRemovalStore {
  chats: ChatItem[]
  deleteChat: (chatId: string, persist?: boolean) => Promise<void>
  patchChat: (chatId: string, partial: Partial<ChatItem>) => void
}

export function removeAgentFromChatList(agentUserId: string, store: ChatListRemovalStore): void {
  for (const chat of store.chats) {
    if (chat.peer_user_id === agentUserId) {
      void store.deleteChat(chat.id)
      continue
    }
    if (!chat.member_user_ids?.includes(agentUserId)) continue
    store.patchChat(chat.id, { member_user_ids: chat.member_user_ids.filter((id) => id !== agentUserId) })
  }
}
