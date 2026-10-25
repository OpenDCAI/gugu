import { useState } from 'react'
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components'
import { useSessionMentionDrop } from '../../session/renderer/lib/chat/use-session-mention-drop'
import type { LocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import { TaskDropGroupInvite } from './TaskDropGroupInvite'
import type { ChatMessageComposerProps } from './chatComposerModels'

/** A group drop shares the normal mention resolver and the normal member picker. */
export function useChatTaskDrop({ chatId, isGroupChat, groupMembers = [], currentUserId, provider, editorApiRef, enabled }: Pick<ChatMessageComposerProps, 'chatId' | 'isGroupChat' | 'groupMembers' | 'currentUserId'> & {
  provider: LocalSessionMentionProvider
  editorApiRef: { current: PromptEditorRef | null }
  enabled: boolean
}) {
  const [invite, setInvite] = useState<{ chatId: string; item: MentionItem } | null>(null)
  if (invite && (invite.chatId !== chatId || !enabled || !isGroupChat)) setInvite(null)
  const drop = useSessionMentionDrop({ provider, editorApiRef, onMentionResolved: (item) => {
    if (!enabled) return false
    if (!isGroupChat || groupMembers.some((member) => `aid:${member.id}` === item.label)) return
    if (chatId) setInvite({ chatId, item })
    return false
  } })
  return { ...drop, invitation: invite && invite.chatId === chatId
    ? <TaskDropGroupInvite key={`${invite.chatId}:${invite.item.id}`} chatId={invite.chatId} agentId={invite.item.label.slice('aid:'.length)} currentUserId={currentUserId} onClose={() => setInvite(null)} /> : null }
}
