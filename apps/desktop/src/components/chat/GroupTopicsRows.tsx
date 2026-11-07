import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { chatActivityAt, chatAttention } from '@gugu/core/shared/ui/chatModels'
import { Pin, PinOff } from '@/lib/icons'
import { chatPreviewText } from '@/lib/agentTurnFailure'
import { formatCalendarDay } from '@/i18n/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { IconButton } from '../ui/IconButton'
import { MenuItem, MenuSeparator } from '../ui/Menu'
import { openPinnedTopic, topicMenuGroups, type SourceTopic } from './topicPinsModel'
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

/** 叫到你的条数:红底,和项目行上的数同一个来源。 */
export function TopicCallChip({ count, at = false }: { count: number; at?: boolean }) {
  return <Chip tone="danger" shape="count">{at ? '@' : ''}{count > 99 ? '99+' : count}</Chip>
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
    {topicMenuGroups(pins).map((group, index) => <Fragment key={group[0]!.id}>
      {index > 0 && <MenuSeparator />}
      {group.map(topic => <TopicMenuRow key={topic.id} topic={topic} pinned={pins.pinned.includes(topic)} pins={pins} />)}
    </Fragment>)}
    {pins.topics.length === 0 && <MenuItem disabled><span className="gg-topic-empty">{t('history.empty.topics')}<small>{t('topic.pins.emptyHint')}</small></span></MenuItem>}
  </>
}

function TopicMenuRow({ topic, pinned, pins }: { topic: SourceTopic; pinned: boolean; pins: ReturnType<typeof useChatTopicPins> }) {
  const { t } = useTranslation('messaging')
  const pinLabel = t(pinned ? 'topic.pins.unpin' : 'topic.pins.pin', { name: topic.name })
  const menu = useRowContextMenu()
  const markRead = useMarkChatsRead()
  const calls = chatAttention(topic).askingYou
  return <div className="gg-topic-menu-row" data-topic-id={topic.id} data-pinned={pinned || undefined} onContextMenu={menu.onContextMenu}>
    {menu.menuPos && <ConversationRowContextMenu {...menu.menuPos} onClose={menu.closeMenu}
      state={{ kind: 'topic', hasUnread: hasUnreadInRows([topic]), hasAnyUnread: hasUnreadInRows(pins.topics) }}
      onAction={(action) => markRead(action === 'mark-all-read' ? pins.topics.map((row) => row.id) : topic.id)} />}
    <MenuItem data-testid="group-menu-topic" className="gg-topic-menu-open" onClick={() => openPinnedTopic(topic)}>
      <span className="gg-topic-menu-body"><span className="gg-topic-menu-line"><span className="gg-topic-name" data-unread={topic.unread_count > 0 || undefined}>{pinned && <Pin size={12} aria-hidden />}<span className="truncate">{topic.name}</span></span><span className="gg-topic-time">{formatCalendarDay(chatActivityAt(topic))}</span></span>
      <span className="gg-topic-menu-line gg-topic-preview" data-calling={calls > 0 || undefined}><span className="truncate">{calls > 0 ? t('topic.calledYou') : chatPreviewText(topic)}</span></span></span>
      {topic.unread_count > 0 && <span className="gg-topic-menu-unread">{calls > 0 ? <TopicCallChip count={calls} /> : <TopicUnreadChip count={topic.unread_count} muted={topic.is_muted} />}</span>}
    </MenuItem>
    <MenuItem render={<IconButton size="sm" aria-label={pinLabel}>{pinned ? <PinOff size={14} /> : <Pin size={14} />}</IconButton>} nativeButton title={pinLabel} data-testid="group-topic-pin" className="gg-topic-menu-pin"
      style={topicPinStyle} closeOnClick={false} disabled={!pins.ready || pins.saving} onClick={() => pins.set(topic.id, !pinned)}>
      {null}
    </MenuItem>
  </div>
}
