import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { parseComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { TaskStatusMark } from '@/components/chat/ComposerCardView'
import { SegmentedTabs } from '@/components/ui/SegmentedTabs'
import { useAgentDisplayStatuses } from '@/hooks/useAgentDisplayStatus'
import { Hash } from '@/lib/icons'
import { useChatStore } from '@/store/chatContext'
import './phone-chat-tabs.css'

const MAIN = 'main'
const LABEL_MAX = 9

// 页签只露话题名的前一截:一件任务的名字可能是整句话,整句摆上去一枚就占满一排。
const shortName = (name: string) => (name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX)}…` : name)

/**
 * 手机对话页头下面那排页签(owner 10-25「群-话题 项目-agent 是有主子关系的……和桌面类似分 tab」,
 * 10-26「项目群的分 tab 也是 topic」):第一枚「群聊」是这段对话本身,后面每个话题一枚 —— 项目里每件任务都是一个话题。
 * 点一枚 = 消息区换成它,页头不动,输入框跟着对它说。任务的话题(开在任务卡上)后面跟它的状态(在跑 / 等你),
 * 停下了才挂未读数。没有话题的对话不露这一排。
 */
export function PhoneChatTabs({ topics, messages, current, onPick }: {
  topics: readonly TopicSummary[]
  /** 这段对话已读进来的消息:从里面认出哪个话题开在任务卡上、交给了谁。 */
  messages: readonly MessageItem[]
  /** 此刻摆着的话题;null = 群聊那一枚。 */
  current: string | null
  onPick: (topic: TopicSummary | null) => void
}) {
  const { t } = useTranslation('messaging')
  const { chats } = useChatStore('chats')
  const bar = useRef<HTMLDivElement>(null)
  const value = current ?? MAIN
  const agentOf = useMemo(() => {
    const anchors = new Set(topics.map((topic) => topic.source_message_id))
    const byAnchor = new Map<string, string>()
    for (const message of messages) {
      if (!anchors.has(message.id) || message.content_type !== 'card') continue
      const card = parseComposerCard(message.content)
      if (card?.type === 'task') byAnchor.set(message.id, card.agentUserId)
    }
    return byAnchor
  }, [topics, messages])
  const statuses = useAgentDisplayStatuses([...new Set(agentOf.values())])
  // 选中的那枚滑进视野:只动这一排自己的 scrollLeft(scrollIntoView 会连外层页面一起滚)。
  useEffect(() => {
    const row = bar.current
    const tab = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    if (!row || !tab) return
    const pad = 16
    if (tab.offsetLeft - pad < row.scrollLeft) row.scrollLeft = tab.offsetLeft - pad
    else if (tab.offsetLeft + tab.offsetWidth + pad > row.scrollLeft + row.clientWidth) row.scrollLeft = tab.offsetLeft + tab.offsetWidth + pad - row.clientWidth
  }, [value])
  if (topics.length === 0) return null
  const items = [
    { value: MAIN, label: t('topic.phoneTabs.group'), testId: 'phone-chat-tab-main' },
    ...topics.map((topic) => {
      const agent = agentOf.get(topic.source_message_id)
      const status = agent ? statuses[agent] : undefined
      const busy = status === 'working' || status === 'parked' || status === 'needs_user' || status === 'error'
      return {
        value: topic.chat_id,
        label: shortName(topic.name),
        icon: <Hash size={14} aria-hidden />,
        marker: busy ? <TaskStatusMark status={status} /> : undefined,
        badge: chats.find((chat) => chat.id === topic.chat_id)?.unread_count ?? 0,
        testId: `phone-chat-tab-${topic.chat_id}`,
      }
    }),
  ]
  return (
    <div ref={bar} className="gg-phone-chat-tabs" data-testid="phone-chat-tabs">
      <SegmentedTabs
        variant="underline"
        ariaLabel={t('topic.phoneTabs.label')}
        items={items}
        value={value}
        onChange={(next) => onPick(next === MAIN ? null : topics.find((topic) => topic.chat_id === next) ?? null)}
      />
    </div>
  )
}
