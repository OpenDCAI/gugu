import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { chatActivityAt } from '@gugu/core/shared/ui/chatModels'
import { Pin, PinOff } from '@/lib/icons'
import { chatPreviewText } from '@/lib/agentTurnFailure'
import { formatCalendarDay } from '@/i18n/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { MenuItem, MenuSeparator } from '../ui/Menu'
import { openPinnedTopic, type SourceTopic } from './topicPinsModel'
import { useChatTopicPins } from './useChatTopicPins'
import { ConversationRowContextMenu } from './ConversationRowContextMenu'
import { useRowContextMenu } from '../../hooks/useRowContextMenu'
import { useMarkChatsRead } from '../../hooks/useMarkChatsRead'
import { hasUnreadInRows } from '../../session/shared/conversation-row-menu'
import './pinned-topics.css'

const topicPinStyle = { padding: 0, minHeight: 0 }

export function TopicUnreadChip({ count, muted = false }: { count: number; muted?: boolean }) {
  return count > 0 ? <Chip tone={muted ? 'default' : 'accent'} shape="count">{count > 99 ? '99+' : count}</Chip> : null
}

export function TopicPinsError({ pins }: { pins: Pick<ReturnType<typeof useChatTopicPins>, 'error' | 'retry'> }) {
  const { t } = useTranslation('messaging')
  return pins.error ? <div role="alert" className="gg-topic-pins-error">{t('topic.pins.loadFailed')} <Button variant="ghost" size="sm" onClick={pins.retry}>{t('common.retry')}</Button></div> : null
}

/** Both the dropdown and pinned strip read the existing live chat/topic projection. */
export function GroupTopicsRows({ chatId }: { chatId: string }) {
  const { t } = useTranslation('messaging')
  const pins = useChatTopicPins(chatId)
  return <>
    <TopicPinsError pins={pins} />
    {[...pins.pinned, ...pins.others].map((topic, index) => <Fragment key={topic.id}>
      {index > 0 && index === pins.pinned.length && <MenuSeparator />}
      <TopicMenuRow topic={topic} pinned={index < pins.pinned.length} pins={pins} />
    </Fragment>)}
    {pins.topics.length === 0 && <MenuItem disabled><span className="gg-topic-empty">{t('history.empty.topics')}<small>{t('topic.pins.emptyHint')}</small></span></MenuItem>}
  </>
}

function TopicMenuRow({ topic, pinned, pins }: { topic: SourceTopic; pinned: boolean; pins: ReturnType<typeof useChatTopicPins> }) {
  const { t } = useTranslation('messaging')
  const pinLabel = t(pinned ? 'topic.pins.unpin' : 'topic.pins.pin', { name: topic.name })
  const menu = useRowContextMenu()
  const markRead = useMarkChatsRead()
  return <div className="gg-topic-menu-row" data-topic-id={topic.id} data-pinned={pinned || undefined} onContextMenu={menu.onContextMenu}>
    {menu.menuPos && <ConversationRowContextMenu {...menu.menuPos} onClose={menu.closeMenu}
      state={{ kind: 'topic', hasUnread: hasUnreadInRows([topic]), hasAnyUnread: hasUnreadInRows(pins.topics) }}
      onAction={(action) => markRead(action === 'mark-all-read' ? pins.topics.map((row) => row.id) : topic.id)} />}
    <MenuItem data-testid="group-menu-topic" className="gg-topic-menu-open" onClick={() => openPinnedTopic(topic)}>
      <span className="gg-topic-menu-body"><span className="gg-topic-menu-line"><span className="gg-topic-name" data-unread={topic.unread_count > 0 || undefined}>{pinned && <Pin size={12} aria-hidden />}<span className="truncate">{topic.name}</span></span><span className="gg-topic-time">{formatCalendarDay(chatActivityAt(topic))}</span></span>
      <span className="gg-topic-menu-line gg-topic-preview"><span className="truncate">{chatPreviewText(topic)}</span></span></span>
      {topic.unread_count > 0 && <span className="gg-topic-menu-unread"><TopicUnreadChip count={topic.unread_count} muted={topic.is_muted} /></span>}
    </MenuItem>
    <MenuItem render={<IconButton size="sm" aria-label={pinLabel}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</IconButton>} nativeButton title={pinLabel} data-testid="group-topic-pin" className="gg-topic-menu-pin"
      style={topicPinStyle} closeOnClick={false} disabled={!pins.ready || pins.saving} onClick={() => pins.set(topic.id, !pinned)}>
      {null}
    </MenuItem>
  </div>
}
