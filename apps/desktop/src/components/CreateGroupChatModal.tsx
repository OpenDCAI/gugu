import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../store/chatContext'
import { useContactsStore } from '../store/contactsContext'
import { useToast } from './toastContext'
import { messageForUser } from '../lib/userFacingError'
import { MemberPicker } from './member-picker/MemberPicker'

interface CreateGroupChatModalProps {
  onClose: () => void
  onCreated: (chatId: string) => void
  /** 预填群名（如从工作台模板组建时传模板名）；传入即用它，不再按所选成员起名。 */
  initialName?: string
  initialSelectedIds?: string[]
}

// 新建群聊 = 选成员(member-picker,与「添加成员」同一个选择器)+ 建群。弹窗里没有群名输入框:
// 没有模板名时,群名就是所选成员的名字按选中先后连起来。
export function CreateGroupChatForm({ onClose, onCreated, initialName, initialSelectedIds }: CreateGroupChatModalProps) {
  const { t } = useTranslation('contacts')
  const { contacts } = useContactsStore()
  const { createGroupChat } = useChatStore('createGroupChat')
  const { toast } = useToast()
  const [creating, setCreating] = useState(false)

  const create = async (ids: string[]) => {
    const names = ids.flatMap((id) => contacts.find((contact) => contact.id === id)?.display_name ?? [])
    const name = (initialName ?? names.join('、')).trim() || t('createGroup.fallbackName')
    setCreating(true)
    try {
      onCreated(await createGroupChat(name, ids))
    } catch (e) {
      toast(t('createGroup.failed'), 'error', messageForUser(e))
    } finally {
      setCreating(false)
    }
  }

  return (
    <MemberPicker
      title={t('createGroup.title')}
      confirmLabel={(count) => (count > 0 ? t('createGroup.createWithCount', { count }) : t('createGroup.create'))}
      busy={creating}
      busyLabel={t('createGroup.creating')}
      initialSelectedIds={initialSelectedIds}
      onConfirm={create}
      onClose={onClose}
    />
  )
}

export { MEMBER_PICKER_SHEET } from './member-picker/MemberPicker'
