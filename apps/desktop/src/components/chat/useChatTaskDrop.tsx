import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { MentionItem, PromptEditorRef } from '@gugu/session-ui/react/components'
import { chatService } from '../../lib/chat'
import { canInviteHumansToGroup, isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { groupJoinError } from '../../lib/groupAgentJoinService'
import { UI_EVENTS } from '../../lib/uiEvents'
import { useSessionMentionDrop } from '../../session/renderer/lib/chat/use-session-mention-drop'
import type { LocalSessionMentionProvider } from '../../session/renderer/lib/chat/local-session-mention-provider'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Button'
import { AddGroupMembers } from './AddGroupMembers'
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

function TaskDropGroupInvite({ chatId, agentId, currentUserId, onClose }: {
  chatId: string; agentId: string; currentUserId?: string | null; onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [group, setGroup] = useState<{ snapshot: GroupCollabSnapshot; canInviteHumans: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projectGroup = isProjectGroupChat(chatId)
  useEffect(() => {
    let active = true
    void (async () => {
      const { snapshot } = await chatService.getGroupCollab(chatId)
      const role = snapshot.humans.find((member) => member.id === currentUserId)?.role
      if (!role) throw new Error('actor_not_member')
      const settings = await chatService.getGroupChatSettings(chatId)
      if (active) setGroup({ snapshot, canInviteHumans: !projectGroup && canInviteHumansToGroup({ viewerRole: role, allowMemberInvite: settings.allow_member_invite }) })
    })().catch((reason: Error) => { if (active) setError(groupJoinError(reason).message) })
    return () => { active = false }
  }, [chatId, currentUserId, projectGroup, t])
  if (!group) return <Sheet onClose={onClose} ariaLabel={t('group.picker.title')}>
    <div className="!p-5">
      <p role={error ? 'alert' : 'status'}>{error ?? t('common.loading')}</p>
      <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
    </div>
  </Sheet>
  return <AddGroupMembers chatId={chatId} snapshot={group.snapshot} canInviteHumans={group.canInviteHumans}
    humanDeniedHint={projectGroup ? t('group.projectGroupNoInvite') : undefined} initialSelectedIds={[agentId]} onClose={onClose}
    onReload={async () => {
      const { snapshot } = await chatService.getGroupCollab(chatId)
      setGroup((held) => held && { ...held, snapshot })
      window.dispatchEvent(new CustomEvent(UI_EVENTS.groupCollabChanged, { detail: { chatId } }))
    }} />
}
