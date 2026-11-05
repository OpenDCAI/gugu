import { useTranslation } from 'react-i18next'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { useAuth } from '../../store/auth'
import { useAgentLook } from '../agentAvatar/useAgentLook'
import { useIsAssistantAvatar } from '../../lib/avatarIdentity'
import { memberNameHue } from '../../lib/memberNameHue'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { fmtMsgTime } from './messageRowTime'
import './messageBubbleChrome.css'
import { useMessageSenderTarget } from './MessageSenderContext'
import { openMessageSender } from '../../lib/openMessageSender'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

// 气泡自己的「谁说的 / 什么时候」(owner 10-25「名字进气泡、时间进右下角」,照 Telegram):
// 名字在气泡第一行、小一号、按这个人的颜色;时间在气泡右下角,和最后一行正文同一行。

// @@@owner-fit-batch - every sender row shares one observer: its first delivery comes after layout and before paint, and it
// measures all rows before toggling any. A per-row measure read layout right after the previous row's write, so opening a
// conversation forced one full layout per agent message (owner-scale switch profile: ~0.5 s of a 2 s switch).
let ownerFit: ResizeObserver | undefined
function ownerFitObserver(): ResizeObserver {
  return ownerFit ??= new ResizeObserver((entries) => {
    const rows = [...new Set(entries.map((entry) => entry.target.closest<HTMLElement>('.msg-sender')))].filter((row) => row !== null)
    const hidden = rows.map(ownerLabelOverflows)
    rows.forEach((row, index) => row.toggleAttribute('data-owner-hidden', hidden[index]))
  })
}

function ownerLabelOverflows(row: HTMLElement): boolean {
  const name = row.querySelector<HTMLElement>('.msg-sender-name')
  const owner = row.querySelector<HTMLElement>('[data-message-agent-owner]')
  if (!name || !owner) return false
  const text = document.createRange(); text.selectNodeContents(name)
  const mark = row.querySelector<HTMLElement>('.gg-chat-reply-quote')
  const gap = parseFloat(getComputedStyle(row).columnGap)
  const available = row.clientWidth - text.getBoundingClientRect().width - (mark?.getBoundingClientRect().width ?? 0) - gap * (mark ? 2 : 1)
  // Keep a readable ellipsis and its padding, or hide the entire secondary label.
  return available < parseFloat(getComputedStyle(owner).fontSize) + 2 * gap
}

/** 群里收到的消息、组首那一条:名字 + 归属小标签(「我的 agent」「Alice 的 agent」)。
 *  色相来自头像实际身体色;助理沿已保存的形象,亮度/彩度随主题(tokens.css)。 */
export function BubbleSender({ member, displayName, senderId, replyMark }: { member: MemberProfileCardModel | null; displayName?: string; senderId: string | null; replyMark?: ReactNode }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const target = useMessageSenderTarget()
  const rowRef = useRef<HTMLDivElement>(null)
  const hasReply = Boolean(replyMark)
  const name = displayName ?? member?.displayName ?? ''
  const assistant = useIsAssistantAvatar(senderId ?? '')
  const assistantLook = useAgentLook(assistant ? senderId ?? '' : '', undefined, member?.avatar)
  const hue = memberNameHue({ id: senderId, avatar: member?.avatar, isAgent: member?.type === 'agent', assistantLook: assistant ? assistantLook : undefined })
  const tag = member?.removedAt ? t('message.removedIdentityTag') : member?.type !== 'agent' ? null
    : member.ownerUserId && member.ownerUserId === user?.id ? t('message.myAgentTag')
    : member.ownerDisplayName ? t('message.agentOwnerTag', { owner: member.ownerDisplayName })
    : t('message.agentOwnerUnavailableTag')
  useLayoutEffect(() => {
    const row = rowRef.current
    const name = row?.querySelector<HTMLElement>('.msg-sender-name')
    if (!row || !name || !row.querySelector('[data-message-agent-owner]')) return
    const observer = ownerFitObserver()
    observer.observe(row); observer.observe(name)
    return () => { observer.unobserve(row); observer.unobserve(name) }
  }, [tag, name, hasReply, target])
  return (
    <div ref={rowRef} data-message-who="true" data-message-sender-name="true" className="msg-sender" style={{ '--member-hue': hue } as React.CSSProperties}>
      {target ? <Button variant="ghost" size="sm" className="msg-sender-name msg-sender-link" onClick={event => { event.stopPropagation(); openMessageSender(target) }}><span className="msg-sender-name">{name}</span></Button>
        : <span className="msg-sender-name">{name}</span>}
      {replyMark}
      {tag && <Chip appearance="filled" data-message-agent-owner="true">{tag}</Chip>}
    </div>
  )
}

/** 气泡右下角的时间。inline = 和最后一行正文同一行(正文末尾由 .msg-time-room 留出位子);否则单独占气泡最后一行。 */
export function BubbleTime({ iso, isMine, inline, replyMark, hideTime }: { iso: string; isMine: boolean; inline: boolean; replyMark?: ReactNode; hideTime?: boolean }) {
  return <span data-message-time="true" data-mine={isMine || undefined} data-inline={inline || undefined} className="msg-time">{replyMark}{!hideTime && fmtMsgTime(iso)}</span>
}

// @@@1345 已读进度圆环：环填充比例=read/total。空环=已发出无人读(#5649 起渲染)；部分=进度弧；满=实心 + 对比色勾。@@@live-accent (Refs #6105) 弧与满环从 --accent(#fff/#000)改到 --live:「已读完成」是 live 态,画的是真实读数不是装饰灯。
export function ReadReceiptRing({ read, total }: { read: number; total: number }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, read / total)) : 0
  const r = 5.5
  const circ = 2 * Math.PI * r
  const full = frac >= 1
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
      {/* @@@1483 空环(sent/未读)轨道色：原 --border-strong(0.12 alpha 发丝分隔线 token)做独立图标 → 白底上
          几乎不可见(QA round1)。改用 muted-foreground token --text-tertiary(#9a9aa2 light/#6f6f78 dark)：
          两端主题都清晰可见,又低于已读态 accent 的层级(sent<partial<read)。 */}
      <circle cx="7.5" cy="7.5" r={r} fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" />
      {frac > 0 && !full && (
        <circle
          cx="7.5"
          cy="7.5"
          r={r}
          fill="none"
          stroke="var(--live)"
          strokeWidth="1.5"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          strokeLinecap="round"
          transform="rotate(-90 7.5 7.5)"
        />
      )}
      {full && (
        <>
          <circle cx="7.5" cy="7.5" r={r + 0.4} fill="var(--live)" />
          {/* 勾用 --text-on-accent(=--primary-fg)：两侧主题各自落在背景那一端,画在 --live 上都够对比。❌ 别用恒 #fff 的 surface-white,深色侧白勾压亮蓝会糊 */}
          <path d="M5 7.6l1.8 1.8 3.3-3.6" stroke="var(--text-on-accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  )
}
