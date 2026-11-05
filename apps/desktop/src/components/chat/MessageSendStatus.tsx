// @@@send-outbox (#1762 洞③/#1941) — 消息传输瞬态指示,从 MessageBubble 抽出(冻结文件净减)。
// sending = 虚线环流动(#5649,原小钟);failed 升级为 fail-loud 可见面(#1941 核心 + 拍板 b):
// **内联「未送达」红字**(不许只靠 15px 红圈——旧的纯装饰红圈正是 bug 的一部分)+ 点击弹出
// 重试/丢弃 popover。重试/丢弃经 useChatStore 直连 outbox(无 props 钻孔,冻结调用方零增行)。
// @@@1460 sent/delivered/read 仍归读回执圆环表达,本组件只管 sending/failed,返回 null 以外不重叠。

import { useTranslation } from 'react-i18next'
import type { MessageSendState, MessageItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../../store/chatContext'
import { FailedSendStatus } from './FailedSendStatus'
import { useAttachmentUploadProgress } from '../../lib/attachmentUploadProgress'
import { MessageSendingIndicator } from './MessageSendingIndicator'

type Props = { state: MessageSendState; messageId: string; reason?: string | null; retryable?: boolean; blocks?: MessageItem['delivery_blocks']; undeliveredTo?: readonly string[] }

export function MessageSendStatus(props: Props) {
  const { t } = useTranslation('messaging')
  const { identitiesById } = useChatStore('identitiesById')
  return <>
    {props.blocks?.map((block) => <span key={block.agent_user_id} data-agent-delivery-block="agent_archived" data-agent-id={block.agent_user_id}
      className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
      {identitiesById[block.agent_user_id]?.display_name ? `${identitiesById[block.agent_user_id].display_name} · ` : ''}{t('message.sendStatus.archived')}
    </span>)}
    {/* 没有运行中的实例持有它叫醒的 agent:等不来,字直接写在气泡旁(手机没有悬停);写名字,因为群里的人是收到了的。 */}
    {props.undeliveredTo?.map((agentId) => <span key={agentId} data-send-state="undelivered" data-agent-id={agentId} title={t('agent.turnFailure.undelivered')}
      className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">
      {identitiesById[agentId]?.display_name ? `${identitiesById[agentId].display_name} · ` : ''}{t('message.sendStatus.undelivered')}
    </span>)}
    <MessageTransportStatus {...props} />
  </>
}

function MessageTransportStatus({ state, messageId, reason, retryable = true }: Props) {
  const { t } = useTranslation('messaging')
  const { retrySend, discardSend } = useChatStore('retrySend', 'discardSend')
  const progress = useAttachmentUploadProgress(messageId)

  if (state === 'unknown') return <span data-send-state="unknown" title={t('message.sendStatus.unknownHint')}
    className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('message.sendStatus.unknown')}</span>

  if (state === 'sending') {
    const label = t('message.sendStatus.sending')
    if (progress?.total && progress.loaded > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor(progress.loaded / progress.total * 100)))
      return <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        data-send-state="sending" className="text-[length:var(--font-caption)] text-[var(--text-secondary)] tabular-nums">{percent}%</span>
    }
    return <MessageSendingIndicator label={label} title={label} />
  }

  if (state === 'failed') return <FailedSendStatus reason={reason} onRetry={retryable ? () => retrySend(messageId) : undefined} onDiscard={() => discardSend(messageId)} />

  // sent/delivered/read → 读回执圆环表达(@@@1460),这里不重复指示
  return null
}
