import type { ReactNode } from 'react'
import type { GroupRosterCandidate } from '@/lib/mention'
import type { ComposerAttachAction } from './ComposerAttachButton'
import type { AgentStatusById } from './agentMentionStatusModels'

export interface ChatMessageComposerProps {
  // @@@threads (#957) — opts 加可选 threadRootId：话题视图发送时由 ChatAreaPanel 注入活动话题 id。
  // @@@whisper (#820) — opts 加可选 isWhisper：悄悄话模式下强制设为 true。
  onSend: (content: string, opts?: { toUserIds?: string[] | null; replyToMessageId?: string | null; threadRootId?: string | null; isWhisper?: boolean; beforeDeliver?: () => Promise<void> }) => Promise<void>
  /** 发送前置(agent 私聊的会话就绪)。文字消息把它交给 onSend 的 beforeDeliver,在投递前跑,❌ 挡在上屏之前(C1)。 */
  beforeSend?: () => Promise<void>
  onSendAttachments?: (files: File[], opts?: { toUserIds?: string[] | null; isWhisper?: boolean; caption?: string; onSent?: (file: File, index: number) => void }) => Promise<void>
  quoteContent?: { messageId?: string; senderName: string; content: string } | null
  onQuoteConsumed?: () => void
  mentionToInsert?: { id: string; name: string } | null
  onMentionInserted?: () => void
  chatId?: string | null
  isGroupChat?: boolean
  groupMembers?: GroupRosterCandidate[]
  currentUserId?: string | null; agentStatuses?: AgentStatusById
  disabled?: boolean
  disabledReason?: string
  // @@@threads — 话题视图下占位文案改「回复话题…」(设计稿 switchThreadIn 行为)；缺省=主线文案。
  placeholder?: string
  attachGlyph?: ReactNode // #7199 助理 App 里是「+」;缺省回形针
  attachMenu?: readonly ComposerAttachAction[] // #7199 给了就把「+」做成菜单(文件 + 这几项);缺省点了直接选文件
  // @@@whisper (#820) — 悄悄话模式：设置后显示 banner + 发送带 isWhisper/toUserIds。
  whisperTarget?: { userId: string; displayName: string } | null
  onExitWhisper?: () => void
  surface?: 'main' | 'aside'; hidden?: boolean // @@@5856 主输入框还是副栏(话题分栏);只有主的登记全局聚焦落点,因果见 lib/focusComposer.ts
}
