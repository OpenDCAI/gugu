import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChatStore } from '../../store/chatContext'
import { MenuSwitchItem } from '../ui/Menu'
import { useToast } from '../toastContext'
import { messageForUser } from '../../lib/userFacingError'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'

/** The same optimistic chat state and mutations used by the list and conversation settings. */
export function ChatHeaderSwitches() {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { activeChat, pinChat, setChatNotificationLevel } = useChatStore('activeChat', 'pinChat', 'setChatNotificationLevel')
  const [pending, setPending] = useState<'pin' | 'mute' | null>(null)
  if (!activeChat) return null
  const pinned = Boolean(activeChat.is_pinned)
  const muted = activeChat.notification_level === 'none'
  const change = async (kind: 'pin' | 'mute', checked: boolean) => {
    setPending(kind)
    try {
      if (kind === 'pin') await pinChat(activeChat.id, checked)
      else await setChatNotificationLevel(activeChat.id, checked ? 'none' : 'all')
    } catch (error) {
      toast(t(kind === 'pin' ? 'chatArea.management.pinFailed' : 'chatArea.management.notificationFailed', { reason: messageForUser(error) }), 'error')
    } finally { setPending(null) }
  }
  return <>
    <MenuSwitchItem data-testid={AUTOMATION_TEST_IDS.chatHeaderPinSwitch} label={t('header.pinConversation')} checked={pinned} disabled={pending !== null} onCheckedChange={(checked) => void change('pin', checked)} />
    <MenuSwitchItem data-testid={AUTOMATION_TEST_IDS.chatHeaderMuteSwitch} label={t('header.mute')} checked={muted} disabled={pending !== null} onCheckedChange={(checked) => void change('mute', checked)} />
  </>
}
