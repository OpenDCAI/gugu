import { useTranslation } from 'react-i18next'
import { chatActivityAt } from '@gugu/core/shared/ui/chatModels'
import { Avatar } from '@/components/Avatar'
import { Chip } from '@/components/ui/Chip'
import { ListRow } from '@/components/ui/ListRow'
import { chatPreviewText } from '@/lib/agentTurnFailure'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { formatCalendarDay } from '@/lib/calendarTime'
import { useChatStore } from '@/store/chatContext'
import { PhoneGuguTabIcon } from './PhoneGuguTabIcon'
import type { PhoneAssistantState } from './usePhoneAssistant'

/**
 * 「消息」置顶的第一行:咕咕(owner 10-26:「咕咕不单独弄一个界面了,成为会话首个」),点它整屏推进咕咕页。
 * 和别的会话行同一个 ListRow:头像、名字、它最后一句、时间、未读;它那条私聊不再另占一行。
 * 还没有它(新用户)也在这一行,点进去是给它安家的引导。没有长按菜单:它不能被删、置顶或免打扰。
 */
export function PhoneAssistantRow({ state, onOpen }: { state: PhoneAssistantState; onOpen: () => void }) {
  const { t } = useTranslation('assistant')
  const { chats } = useChatStore('chats')
  const chat = state.chatId ? chats.find((candidate) => candidate.id === state.chatId) : undefined
  const contact = state.assistant
  const name = contact?.display_name ?? t('rail')
  const unread = chat?.unread_count ?? 0
  return (
    <>
    <ListRow
      mobile
      data-first-run-hint="assistant"
      data-first-run-device="phone"
      role="option"
      aria-selected={false}
      data-testid={AUTOMATION_TEST_IDS.mobileAssistantNav}
      emphasis={unread > 0}
      onClick={onOpen}
      leading={contact
        ? <Avatar name={name} avatarUrl={contact.avatar} seed={contact.id} size={48} isAgent harnessBadge={false} />
        : <PhoneGuguTabIcon name={name} fresh={state.stage.stage === 'onboarding'} />}
      title={name}
      meta={chat ? formatCalendarDay(chatActivityAt(chat)) : undefined}
      subtitle={chat ? chatPreviewText(chat) : undefined}
      trailing={unread > 0 ? <Chip tone="accent" shape="count">{unread > 99 ? '99+' : unread}</Chip> : undefined}
    />
    <div data-first-run-hint-space="assistant" />
    </>
  )
}
