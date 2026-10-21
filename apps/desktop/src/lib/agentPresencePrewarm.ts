import type { ChatItem } from '@gugu/core/shared/types/chat'

// @@@3839 D — 「这个账号会看到哪些 agent」这个问题，会话列表比任何一个渲染状态点的面板都先知道答案。
// 把答案单独抽成一个纯函数：它要与列表行的判据**逐字一致**，否则预热覆盖面会与实际渲染面悄悄分叉，
// 而分叉出来的那部分只会表现为「某些 agent 偶尔还是先闪一下确认中」——没有任何报错。
//
// 判据同 ChatListPanel 的 chatIsAgent：kind==='ai' 的 DM 对端就是 agent，其余按已解析身份认。
export function collectChatAgentUserIds(
  chats: readonly ChatItem[],
  identitiesById: Readonly<Record<string, { type: 'human' | 'agent' } | undefined>>,
): string[] {
  const ids = new Set<string>()
  for (const chat of chats) {
    const peerId = chat.peer_user_id ?? ''
    if (peerId && (chat.kind === 'ai' || identitiesById[peerId]?.type === 'agent')) ids.add(peerId)
    for (const memberId of chat.member_user_ids ?? []) {
      if (identitiesById[memberId]?.type === 'agent') ids.add(memberId)
    }
  }
  return Array.from(ids).sort()
}
