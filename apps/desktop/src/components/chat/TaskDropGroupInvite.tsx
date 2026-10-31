import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { chatService } from '../../lib/chat'
import { canInviteHumansToGroup, isProjectGroupChat } from '../../lib/groupMemberPermissions'
import { groupJoinError } from '../../lib/groupAgentJoinService'
import { UI_EVENTS } from '../../lib/uiEvents'
import { Sheet } from '../ui/Sheet'
import { Button } from '../ui/Button'
import { AddGroupMembers } from './AddGroupMembers'

export function TaskDropGroupInvite({ chatId, agentId, onClose }: {
  chatId: string; agentId: string; onClose: () => void
}) {
  const { t } = useTranslation('messaging')
  const [group, setGroup] = useState<{ snapshot: GroupCollabSnapshot; canInviteHumans: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const projectGroup = isProjectGroupChat(chatId)
  useEffect(() => {
    let active = true
    void (async () => {
      const { snapshot } = await chatService.getGroupCollab(chatId)
      const settings = await chatService.getGroupChatSettings(chatId)
      if (!settings.my_role) throw new Error('actor_not_member')
      if (active) setGroup({ snapshot, canInviteHumans: !projectGroup && canInviteHumansToGroup(settings) })
    })().catch((reason: Error) => { if (active) setError(groupJoinError(reason).message) })
    return () => { active = false }
  }, [chatId, projectGroup, t])
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
