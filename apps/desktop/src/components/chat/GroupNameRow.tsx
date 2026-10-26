import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { groupDisplayName } from '@gugu/core/shared/ui/chatModels'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { updateDisplayAlias } from '../../lib/displayOverrides'
import { AliasSheet } from '../contacts/AliasSheet'
import { Button } from '../ui/Button'
import { GroupNameInlineEdit } from './GroupNameInlineEdit'

export function GroupNameRow({ chat, name, canEdit, onCommit }: {
  chat: ChatItem; name: string | null; canEdit: boolean; onCommit: (name: string) => Promise<void>
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { refreshChats, patchChat } = useChatStore('refreshChats', 'patchChat')
  const [open, setOpen] = useState(false)
  const save = async (alias: string) => {
    if (!user) throw new Error('An authenticated account is required')
    await updateDisplayAlias(user.id, { kind: 'group', id: chat.id }, alias)
    patchChat(chat.id, { alias: alias.trim() || null })
    await refreshChats()
  }
  return <>
    <div className="flex flex-wrap items-center gap-x-2">
      <GroupNameInlineEdit name={name} canEdit={canEdit} onCommit={onCommit} wrap />
      <Button variant="ghost" size="sm" data-testid="group-set-alias" onClick={() => setOpen(true)}>{t('contextMenu.setAlias')}</Button>
    </div>
    {chat.alias?.trim() ? <div className="text-sm text-[var(--text-secondary)]">{t('profile.alias')} · {groupDisplayName(chat)}</div> : null}
    {open ? <AliasSheet name={name ?? groupDisplayName(chat)} alias={chat.alias} avatarUrl={chat.avatar} seed={chat.id} group onSave={save} onClose={() => setOpen(false)} /> : null}
  </>
}
