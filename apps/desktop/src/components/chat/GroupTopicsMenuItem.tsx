import { useTranslation } from 'react-i18next'
import { compareChatsByActivityDesc } from '@gugu/core/shared/ui/chatModels'
import { MessageSquare } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { requestTopicSplit } from '@/lib/topicSplitRequest'
import { useChatStore } from '../../store/chatContext'
import { MenuItem, MenuSubmenu } from '../ui/Menu'

/** 群页头 ⋯ 的「话题」:本群的话题列表(owner 10-27),点一条走列表点话题的同一条分栏路。 */
export function GroupTopicsMenuItem({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  const topics = chats.filter((chat) => chat.kind === 'topic' && chat.source_chat_id === chatId).sort(compareChatsByActivityDesc)
  return (
    <MenuSubmenu data-testid={AUTOMATION_TEST_IDS.groupMenuTopics} icon={<MessageSquare size={16} />} label={t('history.tabs.topics')}>
      {topics.length === 0
        ? <MenuItem disabled>{t('history.empty.topics')}</MenuItem>
        : topics.map((topic) => (
          <MenuItem key={topic.id} data-testid="group-menu-topic" onClick={() => requestTopicSplit({ chatId: topic.id, name: topic.name ?? '', sourceChatId: chatId, focusComposer: true })}>
            <span className="block truncate">{topic.name}</span>
          </MenuItem>
        ))}
    </MenuSubmenu>
  )
}
