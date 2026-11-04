import { useTranslation } from 'react-i18next'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { ChevronRight, MessageSquare } from '@/lib/icons'
import { formatCalendarDay } from '@/i18n/format'
import { Button } from '../ui/Button'
import { Chip } from '../ui/Chip'
import { topicAnchorLine } from './topicAnchorModels'

/**
 * @@@5856 话题锚点 —— 挂在**来源消息**底下的那一条(product spec)。
 *
 * owner 2026-09-19 对着实机说了三次,每次都指同一个方向「它是那条消息的附件,不是第二条消息」:
 *   ① 最初的样子在 UI 上不成立 —— 当时它是个带边框的方盒子,恒定左对齐、整行铺开,
 *      来源消息靠右时它跑到屏幕另一侧,读者连不起来它挂在谁身上。⇒ 改成贴着气泡同侧、边对边对齐。
 *   ②「你不感觉这个像是个文字重复吗?」—— 话题名默认截自来源消息的开头,而锚点就挂在那条消息底下,
 *      于是同一句话连着出现两遍。⇒ 名字还是自动截的那份时不写名字,只写「话题」(见 topicAnchorModels)。
 *      例外:同一条消息底下不止一条话题时照写名字 —— 两行都读作「话题」就分不出谁是谁。
 *   ③「这个附件气泡不太好看」—— 两行 + 右对齐的参差,在气泡底下比气泡本身还显眼。⇒ 收成**一行**。
 *
 * 现在的形态:一行,贴着气泡那一侧,外侧一条竖轨从气泡底角接下来(tokens.css 的 .gg-topic-anchor)。
 * 内容 =「话题名或『话题』· M 人参与 · N 条 · 谁开的 · 什么时候有动静 ›」。
 * 无边框、hover 才给底色 —— 它是消息的附属物,❌ 不许盖过消息本身(owner 也不要「卡里套卡」)。
 *
 * 可见 / 参与 / 通知是三件事(spec 明令严格分开):`is_participant` 为 false 时挂一枚「只看得见」,
 * 意思是你点得进去看,但它的消息不会来叫你。❌ 不许省 —— 省掉了「消息隔离」这个话题存在的
 * 主要价值在界面上就不可感。
 */
// @@@ui-ruler 结构性 style 一律提到模块作用域(同 ChatListPanel 的 *_STYLE 常量)。
// 气泡列的缩进:消息行左右内距 14 + 头像 32 + 头像与气泡的 gap 11 = 57。锚点要跟气泡对齐,
// 所以自己那一侧留 57、另一侧留 14 —— ❌ 不能两侧都 14,那样它就不在气泡下面了。
const TOPIC_ANCHOR_BUBBLE_INDENT = 57
const TOPIC_ANCHOR_WRAP_STYLE: Record<'mine' | 'theirs', React.CSSProperties> = {
  mine: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2,
    padding: `0 ${TOPIC_ANCHOR_BUBBLE_INDENT}px 4px 14px`,
  },
  theirs: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    padding: `0 14px 4px ${TOPIC_ANCHOR_BUBBLE_INDENT}px`,
  },
}
// 封顶 —— 横铺一整行就是「另一条消息」的形状了。
const TOPIC_ANCHOR_MAX_WIDTH = 320
const TOPIC_ANCHOR_ICON_STYLE: React.CSSProperties = { flexShrink: 0, color: 'var(--text-tertiary)' }
const TOPIC_ANCHOR_LEAD_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-caption)',
  fontWeight: 'var(--font-weight-medium)',
  color: 'var(--text-secondary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
}
const TOPIC_ANCHOR_META_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0,
}
const TOPIC_ANCHOR_DETAIL_STYLE: React.CSSProperties = {
  ...TOPIC_ANCHOR_META_STYLE, flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
}

export type TopicAnchorCardProps = {
  topics: TopicSummary[]
  /** 来源消息是不是自己发的 —— 决定锚点贴左还是贴右(它是那条气泡的附件)。 */
  isMine: boolean
  /** 来源消息的正文 —— 只用来判「话题名是不是还没被改过」,改过才值得再写一遍。 */
  sourceContent: string | null | undefined
  onOpen: (topicChatId: string) => void
  /** 用来把 creator_user_id 换成人看得懂的名字。取不到名字就那半句不画,❌ 不摆「未知用户」。 */
  memberProfiles?: Record<string, { displayName?: string | null }>
}

export function TopicAnchorCard({ topics, isMine, sourceContent, onOpen, memberProfiles }: TopicAnchorCardProps) {
  if (topics.length === 0) return null
  return (
    <div
      data-testid="topic-anchor-card"
      data-topic-anchor-side={isMine ? 'mine' : 'theirs'}
      style={TOPIC_ANCHOR_WRAP_STYLE[isMine ? 'mine' : 'theirs']}
    >
      {topics.map((topic) => (
        <TopicAnchorRow
          key={topic.chat_id}
          topic={topic}
          side={isMine ? 'mine' : 'theirs'}
          sourceContent={sourceContent}
          disambiguate={topics.length > 1}
          onOpen={onOpen}
          memberProfiles={memberProfiles}
        />
      ))}
    </div>
  )
}

// gap 走常量不走 class:6px 是半档,check-ui-visual-spec 在数源码里的半档间距工具类。
const TOPIC_ANCHOR_BUTTON_STYLE: React.CSSProperties = { maxWidth: `min(${TOPIC_ANCHOR_MAX_WIDTH}px, 100%)`, gap: 6 }

function TopicAnchorRow({ topic, side, sourceContent, disambiguate, onOpen, memberProfiles }: {
  topic: TopicSummary
  side: 'mine' | 'theirs'
  sourceContent: string | null | undefined
  disambiguate: boolean
  onOpen: (topicChatId: string) => void
  memberProfiles?: Record<string, { displayName?: string | null }>
}) {
  const { t } = useTranslation('messaging')
  const line = topicAnchorLine(topic, {
    sourceContent,
    genericLead: t('topic.anchor.lead'),
    disambiguate,
    openedBy: (topic.creator_user_id ? memberProfiles?.[topic.creator_user_id]?.displayName : null) ?? null,
    activeAt: topic.last_message_at ? formatCalendarDay(topic.last_message_at, { withTime: true }) : null,
    labels: {
      messageCount: (count) => t('topic.anchor.messageCount', { count }),
      openedBy: (name) => t('topic.anchor.openedBy', { name }),
      quiet: t('topic.anchor.quiet'),
    },
  })
  const participantCount = t('topic.anchor.participantCount', { count: topic.participant_count })
  const summary = [line.lead, participantCount, ...line.segments,
    ...(!topic.is_participant ? [t('topic.anchor.observer')] : [])].join(t('topic.anchor.separator'))
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="topic-anchor-row"
      data-topic-id={topic.chat_id}
      data-topic-participant={topic.is_participant ? 'true' : 'false'}
      aria-label={summary}
      title={summary}
      onClick={() => onOpen(topic.chat_id)}
      // 外侧那条竖轨与对齐方向都在 tokens.css 的 .gg-topic-anchor[data-side] 里 ——
      // 左右交替的气泡里,只有那条轨说得清「我挂在上面那一条上」。
      className="gg-topic-anchor h-auto w-fit min-w-0 items-center px-2 py-1"
      data-side={side}
      style={TOPIC_ANCHOR_BUTTON_STYLE}
    >
      <MessageSquare size={13} style={TOPIC_ANCHOR_ICON_STYLE} />
      <span data-testid="topic-anchor-lead" style={TOPIC_ANCHOR_LEAD_STYLE}>{line.lead}</span>
      <span data-testid="topic-anchor-participant-count" style={TOPIC_ANCHOR_META_STYLE}>{participantCount}</span>
      <span data-testid="topic-anchor-meta" style={TOPIC_ANCHOR_DETAIL_STYLE}>
        {line.segments.join(t('topic.anchor.separator'))}
      </span>
      {!topic.is_participant && (
        <Chip data-testid="topic-anchor-observer">
          {t('topic.anchor.observer')}
        </Chip>
      )}
      <ChevronRight size={12} style={TOPIC_ANCHOR_ICON_STYLE} />
    </Button>
  )
}
