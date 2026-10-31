import { useTranslation } from 'react-i18next'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { useAuth } from '../../store/auth'
import { BODY_COLORS } from '../agentAvatar/engine/identity'
import { resolveAgentLook } from '../agentAvatar/look'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { fmtMsgTime } from './messageRowTime'
import './messageBubbleChrome.css'
import { useMessageSenderTarget } from './MessageSenderContext'
import { openMessageSender } from '../../lib/openMessageSender'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

// 气泡自己的「谁说的 / 什么时候」(owner 10-25「名字进气泡、时间进右下角」,照 Telegram):
// 名字在气泡第一行、小一号、按这个人的颜色;时间在气泡右下角,和最后一行正文同一行。

/** 群里收到的消息、组首那一条:名字 + 归属小标签(「我的 agent」「Alice 的 agent」)。
 *  颜色不另起色板:用身份层按 id 定下的那一档色相(agent 形象的身体色,agent 改过形象就跟着它),亮度/彩度随主题(tokens.css)。 */
export function BubbleSender({ member, senderId, replyMark }: { member: MemberProfileCardModel | null; senderId: string | null; replyMark?: ReactNode }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const target = useMessageSenderTarget()
  const rowRef = useRef<HTMLDivElement>(null)
  const hasReply = Boolean(replyMark)
  const hue = BODY_COLORS[resolveAgentLook(senderId, member?.avatar ?? null).color].hue
  const tag = member?.removedAt ? t('message.removedIdentityTag') : member?.type !== 'agent' ? null
    : member.ownerUserId && member.ownerUserId === user?.id ? t('message.myAgentTag')
    : member.ownerDisplayName ? t('message.agentOwnerTag', { owner: member.ownerDisplayName })
    : t('message.agentOwnerUnavailableTag')
  useLayoutEffect(() => {
    const row = rowRef.current
    const name = row?.querySelector<HTMLElement>('.msg-sender-name')
    const owner = row?.querySelector<HTMLElement>('[data-message-agent-owner]')
    if (!row || !name || !owner) return
    const measure = () => {
      const text = document.createRange(); text.selectNodeContents(name)
      const mark = row.querySelector<HTMLElement>('.gg-chat-reply-quote')
      const gap = parseFloat(getComputedStyle(row).columnGap)
      const available = row.clientWidth - text.getBoundingClientRect().width - (mark?.getBoundingClientRect().width ?? 0) - gap * (mark ? 2 : 1)
      // Keep a readable ellipsis and its padding, or hide the entire secondary label.
      row.toggleAttribute('data-owner-hidden', available < parseFloat(getComputedStyle(owner).fontSize) + 2 * gap)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row); observer.observe(name)
    return () => observer.disconnect()
  }, [tag, member?.displayName, hasReply, target])
  return (
    <div ref={rowRef} data-message-who="true" data-message-sender-name="true" className="msg-sender" style={{ '--member-hue': hue } as React.CSSProperties}>
      {target ? <Button variant="ghost" size="sm" className="msg-sender-name msg-sender-link" onClick={event => { event.stopPropagation(); openMessageSender(target) }}><span className="msg-sender-name">{member?.displayName ?? ''}</span></Button>
        : <span className="msg-sender-name">{member?.displayName ?? ''}</span>}
      {replyMark}
      {tag && <Chip appearance="filled" data-message-agent-owner="true">{tag}</Chip>}
    </div>
  )
}

/** 气泡右下角的时间。inline = 和最后一行正文同一行(正文末尾由 .msg-time-room 留出位子);否则单独占气泡最后一行。 */
export function BubbleTime({ iso, isMine, inline, replyMark, hideTime }: { iso: string; isMine: boolean; inline: boolean; replyMark?: ReactNode; hideTime?: boolean }) {
  return <span data-message-time="true" data-mine={isMine || undefined} data-inline={inline || undefined} className="msg-time">{replyMark}{!hideTime && fmtMsgTime(iso)}</span>
}
