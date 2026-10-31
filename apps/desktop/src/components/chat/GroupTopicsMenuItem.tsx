import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { chatActivityAt } from '@gugu/core/shared/ui/chatModels'
import { MessageSquare, Pin, PinOff } from '@/lib/icons'
import { AUTOMATION_TEST_IDS } from '@/lib/automationDom'
import { chatPreviewText } from '@/lib/agentTurnFailure'
import { formatCalendarDay } from '@/i18n/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { MenuItem, MenuSeparator, MenuSubmenu } from '../ui/Menu'
import { openPinnedTopic, topicUnreadTotal, type SourceTopic } from './topicPinsModel'
import { useChatTopicPins } from './useChatTopicPins'
import './pinned-topics.css'

// Keep the sm box at 28px: MenuItem's touch min-height would enlarge its shared 44px hit area to 60px.
const topicPinStyle = { padding: 0, minHeight: 0 }
const topicOpenStyle = { paddingInlineEnd: 'calc(var(--control-h-touch) + 8px)' }

export function TopicUnreadChip({ count, muted = false }: { count: number; muted?: boolean }) {
  return count > 0 ? <Chip tone={muted ? 'default' : 'accent'} shape="count">{count > 99 ? '99+' : count}</Chip> : null
}

export function TopicPinsError({ pins }: { pins: Pick<ReturnType<typeof useChatTopicPins>, 'error' | 'retry'> }) {
  const { t } = useTranslation('messaging')
  return pins.error ? <div role="alert" className="gg-topic-pins-error">{t('topic.pins.loadFailed')} <Button variant="ghost" size="sm" onClick={pins.retry}>{t('common.retry')}</Button></div> : null
}

/** Header Topics and personal pins use the same live chat projection as the chat list. */
export function GroupTopicsMenuItem({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const pins = useChatTopicPins(chatId)
  return (
    <MenuSubmenu data-testid={AUTOMATION_TEST_IDS.groupMenuTopics} icon={<MessageSquare size={16} />}
      label={<span className="flex items-center justify-between gap-2">{t('history.tabs.topics')}<TopicUnreadChip count={topicUnreadTotal(pins.topics)} /></span>}
      popupStyle={{ width: 320, maxWidth: 'min(320px, var(--available-width))', maxHeight: 'min(360px, var(--available-height))' }} popupClassName="gg-topics-menu">
      <TopicPinsError pins={pins} />
      {[...pins.pinned, ...pins.others].map((topic, index) => <Fragment key={topic.id}>
        {index > 0 && index === pins.pinned.length && <MenuSeparator />}
        <TopicMenuRow topic={topic} pinned={index < pins.pinned.length} pins={pins} />
      </Fragment>)}
      {pins.topics.length === 0 && <MenuItem disabled><span className="gg-topic-empty">{t('history.empty.topics')}<small>{t('topic.pins.emptyHint')}</small></span></MenuItem>}
    </MenuSubmenu>
  )
}

function TopicMenuRow({ topic, pinned, pins }: { topic: SourceTopic; pinned: boolean; pins: ReturnType<typeof useChatTopicPins> }) {
  const { t } = useTranslation('messaging')
  const pinLabel = t(pinned ? 'topic.pins.unpin' : 'topic.pins.pin', { name: topic.name })
  return (
    <div className="gg-topic-menu-row" data-topic-id={topic.id} data-pinned={pinned || undefined}>
      <MenuItem data-testid="group-menu-topic" className="gg-topic-menu-open" style={topicOpenStyle} onClick={() => openPinnedTopic(topic)}>
        <span className="gg-topic-menu-line"><span className="gg-topic-name" data-unread={topic.unread_count > 0 || undefined}>{pinned && <Pin size={12} aria-hidden />}<span className="truncate">{topic.name}</span></span><span className="gg-topic-time">{formatCalendarDay(chatActivityAt(topic))}</span></span>
        <span className="gg-topic-menu-line gg-topic-preview"><span className="truncate">{chatPreviewText(topic)}</span><TopicUnreadChip count={topic.unread_count} muted={topic.is_muted} /></span>
      </MenuItem>
      <MenuItem render={<IconButton size="sm" aria-label={pinLabel}>{null}</IconButton>} nativeButton title={pinLabel} data-testid="group-topic-pin" className="gg-topic-menu-pin"
        style={topicPinStyle} closeOnClick={false} disabled={!pins.ready || pins.saving} onClick={() => pins.set(topic.id, !pinned)}>
        {pinned ? <PinOff size={14} /> : <Pin size={14} />}
      </MenuItem>
    </div>
  )
}
