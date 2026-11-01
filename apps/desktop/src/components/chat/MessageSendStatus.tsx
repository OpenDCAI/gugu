// @@@send-outbox (#1762 洞③/#1941) — 消息传输瞬态指示,从 MessageBubble 抽出(冻结文件净减)。
// sending = 虚线环流动(#5649,原小钟);failed 升级为 fail-loud 可见面(#1941 核心 + 拍板 b):
// **内联「未送达」红字**(不许只靠 15px 红圈——旧的纯装饰红圈正是 bug 的一部分)+ 点击弹出
// 重试/丢弃 popover。重试/丢弃经 useChatStore 直连 outbox(无 props 钻孔,冻结调用方零增行)。
// @@@1460 sent/delivered/read 仍归读回执圆环表达,本组件只管 sending/failed,返回 null 以外不重叠。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageSendState, MessageItem } from '@gugu/core/shared/types/chat'
import { useChatStore } from '../../store/chatContext'
import { DropdownMenu, MenuItem } from '../ui/Menu'
import { safeFailureLine } from '@/session/renderer/features/sessions/gugu-reason'
import { useAttachmentUploadProgress } from '../../lib/attachmentUploadProgress'
import { MessageSendingIndicator } from './MessageSendingIndicator'

type Props = { state: MessageSendState; messageId: string; reason?: string | null; blocks?: MessageItem['delivery_blocks']; undeliveredTo?: readonly string[] }

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

function MessageTransportStatus({ state, messageId, reason }: Props) {
  const { t } = useTranslation('messaging')
  const { retrySend, discardSend } = useChatStore('retrySend', 'discardSend')
  const [menuOpen, setMenuOpen] = useState(false)
  const progress = useAttachmentUploadProgress(messageId)
  const failureReason = safeFailureLine(reason ?? '')

  if (state === 'unknown') return <span data-send-state="unknown" title={t('message.sendStatus.unknownHint')}
    className="text-[length:var(--font-caption)] text-[var(--text-secondary)]">{t('message.sendStatus.unknown')}</span>

  // queued = 已经落库、它叫醒的助理还没接走:同一个发送中,悬停说明在等助理就绪。
  if (state === 'sending' || state === 'queued') {
    const label = t(state === 'queued' ? 'message.sendStatus.queued' : 'message.sendStatus.sending')
    if (state === 'sending' && progress?.total && progress.loaded > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor(progress.loaded / progress.total * 100)))
      return <span role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}
        data-send-state="sending" className="text-[length:var(--font-caption)] text-[var(--text-secondary)] tabular-nums">{percent}%</span>
    }
    return <MessageSendingIndicator label={label} state={state} title={label} />
  }

  if (state === 'failed') {
    return (
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenu.Trigger
          type="button"
          data-testid="message-send-failed"
          aria-label={t('message.sendStatus.failedHint')}
          title={failureReason || undefined}
          className="gg-pressable"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, border: 'none', cursor: 'pointer',
            background: 'transparent', padding: '1px 4px', borderRadius: 'var(--radius-control)', flexShrink: 0,
            color: 'var(--danger-fg)', fontSize: 'var(--font-caption)', lineHeight: 'var(--lh-caption)', whiteSpace: 'nowrap',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 15 15" fill="none" style={{ display: 'block' }}>
            <circle cx="7.5" cy="7.5" r="6" stroke="var(--danger)" strokeWidth="1.5" />
            <path d="M7.5 4.2v3.6" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="7.5" cy="10.8" r=".8" fill="var(--danger)" />
          </svg>
          {t('message.sendStatus.failed')}
        </DropdownMenu.Trigger>
        {menuOpen && (
          <DropdownMenu.Content
            data-testid="message-send-failed-menu"
            aria-label={t('message.sendStatus.failedActions')}
            side="top"
            align="end"
            sideOffset={4}
            style={{ minWidth: 96 }}
          >
            {failureReason && <div className="max-w-72 break-words px-3 py-2 text-[length:var(--font-body)] text-[var(--text-secondary)]">{failureReason}</div>}
            <MenuItem
              render={<button type="button" />}
              nativeButton
              data-testid="message-send-retry"
              onClick={() => { setMenuOpen(false); retrySend(messageId) }}
              style={{ minHeight: 32, fontSize: 'var(--font-body)' }}
            >
              {t('common.retry')}
            </MenuItem>
            <MenuItem
              render={<button type="button" />}
              nativeButton
              data-testid="message-send-discard"
              danger
              onClick={() => { setMenuOpen(false); discardSend(messageId) }}
              style={{ minHeight: 32, fontSize: 'var(--font-body)' }}
            >
              {t('common.discard')}
            </MenuItem>
          </DropdownMenu.Content>
        )}
      </DropdownMenu.Root>
    )
  }

  // sent/delivered/read → 读回执圆环表达(@@@1460),这里不重复指示
  return null
}
