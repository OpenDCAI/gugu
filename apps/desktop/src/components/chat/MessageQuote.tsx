import type { MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import { displayAgentReferences } from '@/lib/mentionMdast'
import { Reply } from '@/lib/icons'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { ComposerCardHead } from './ComposerCardView'
import { partialQuotedContent } from './messageQuoteContent'
import { quoteSummary } from './quoteSummary'
import { ChatReplyQuote, type ReplyQuoteDisclosure } from './ChatReplyQuote'
import { SourcePreview } from '@/components/markdown/SourcePreview'

/**
 * 气泡里引的那一条:谁说的 + 原话,点一下跳到被引用的消息。
 * 引的是一张任务卡(gugu-dev#181):第一行是卡头「✳ 新任务」(谁的卡不用说,卡上有),第二行是原话。
 */
export function MessageQuote({ msg, quoterIsAgent, memberProfiles, onShowMessage, disclosure }: {
  msg: MessageItem
  disclosure?: ReplyQuoteDisclosure
  onShowMessage?: (id: string) => void
  /** 引卡的是 agent(它回群时引自己那张卡):卡头画它的标。 */
  quoterIsAgent: boolean
  memberProfiles?: Record<string, MemberProfileCardModel>
}) {
  const quotedContent = partialQuotedContent(msg)?.quoteText ?? msg.reply_to_content
  const quotedCard = composerCardPreview(quotedContent)
  const showQuoted = (event: MouseEvent) => {
    event.stopPropagation()
    if (msg.reply_to_message_id) onShowMessage?.(msg.reply_to_message_id)
  }
  const preview = (
    <MessageQuoteFrame
      mine={msg.is_mine}
      onClick={onShowMessage ? showQuoted : undefined}
      head={quotedCard ? <ComposerCardHead type={quotedCard.type} agentUserId={quoterIsAgent ? msg.sender_user_id : null} />
        : resolveOrLoud(memberProfiles?.[msg.reply_to_sender_user_id ?? '']?.displayName, `reply sender ${msg.reply_to_message_id ?? msg.id}`)}
      text={displayAgentReferences(quotedCard?.text ?? quotedContent ?? '', (_id, label) => `@${label}`)}
      preview={Boolean(disclosure)}
    />
  )
  return disclosure ? <ChatReplyQuote disclosure={disclosure} onJump={onShowMessage ? () => onShowMessage(msg.reply_to_message_id!) : undefined}>{preview}</ChatReplyQuote> : preview
}

/**
 * 引用块那一面:左边一道竖线、第一行是谁(或卡头)、第二行是原话。只管长相,❌ 读任何数据 ——
 * 群里的引用(MessageQuote)和示例项目(#709)里 agent 引它那张卡画的是同一面。
 */
export function MessageQuoteFrame({ mine, head, text, onClick, preview }: {
  mine: boolean
  head: ReactNode
  text: string
  preview?: boolean
  /** 给了 = 点一下跳到被引用的那一条。 */
  onClick?: (event: MouseEvent) => void
}) {
  const { t } = useTranslation('messaging')
  return (
    <div role={onClick ? "button" : undefined} title={t('message.showQuoted')} onClick={onClick} style={{
      cursor: onClick ? 'pointer' : 'inherit',
      display: 'inline-block',
      overflow: 'hidden',
      borderLeft: `3px solid ${mine ? 'var(--bubble-quote-bar-mine)' : 'var(--bubble-quote-bar-other)'}`,
      paddingLeft: '7px',
      // 气泡比 180 窄时跟着气泡收(窄格里冲出气泡边)。
      maxWidth: 'min(180px, 100%)',
    }}>
      <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, opacity: 0.6, marginBottom: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {head}
      </div>
      {preview ? <SourcePreview text={text} lines={2} style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', maxHeight: 'calc(var(--lh-body) * 2)', opacity: 0.55 }} /> : <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {text}
      </div>}
    </div>
  )
}

/**
 * 私聊里引的那一条:气泡上方一行「发送者 · 短摘要」(owner 10-28,与会话页 #705 同一格式),点一下跳到被引用的消息。
 * 私聊里能引的只有这条私聊自己的消息,所以没有群名那一段;发送者写被引那条自己的发送者(本人、对方、agent 照写),
 * 引的是任务卡时照 gugu-dev#181 写卡头。明确回复目标保留无字标记；只在悬停标记或手机点击标记时展示引用正文。
 * 群里照旧是上面的 MessageQuote。
 */
export function DirectMessageQuote({ msg, quoterIsAgent, memberProfiles, onShowMessage, disclosure }: {
  msg: MessageItem
  disclosure?: ReplyQuoteDisclosure
  quoterIsAgent: boolean
  memberProfiles?: Record<string, MemberProfileCardModel>
  onShowMessage?: (id: string) => void
}) {
  const { t } = useTranslation('messaging')
  const quotedContent = partialQuotedContent(msg)?.quoteText ?? msg.reply_to_content
  const quotedCard = composerCardPreview(quotedContent)
  const sender = quotedCard ? <ComposerCardHead type={quotedCard.type} agentUserId={quoterIsAgent ? msg.sender_user_id : null} />
    : resolveOrLoud(memberProfiles?.[msg.reply_to_sender_user_id ?? '']?.displayName, `reply sender ${msg.reply_to_message_id ?? msg.id}`)
  const source = displayAgentReferences(quotedCard?.text ?? quotedContent ?? '', (_id, label) => `@${label}`)
  const summary = quoteSummary(source)
  const showQuoted = (event: MouseEvent) => {
    event.stopPropagation()
    if (msg.reply_to_message_id) onShowMessage?.(msg.reply_to_message_id)
  }
  const preview = (
    <div data-testid="direct-message-quote" role={onShowMessage ? 'button' : undefined} title={t('message.showQuoted')} onClick={onShowMessage ? showQuoted : undefined}
      className={`flex max-w-full min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap px-[2px] text-[length:var(--font-caption)] leading-[var(--lh-caption)] text-[var(--muted-fg)] ${onShowMessage ? 'cursor-pointer' : ''}`}>
      {!disclosure && <Reply className="size-3 shrink-0" aria-hidden />}
      <span className="max-w-[60%] shrink-0 truncate font-semibold">{sender} ·</span>
      <span className="min-w-0 truncate">{summary}</span>
    </div>
  )
  return disclosure ? <ChatReplyQuote disclosure={disclosure} onJump={onShowMessage ? () => onShowMessage(msg.reply_to_message_id!) : undefined}>
    <MessageQuoteFrame mine={msg.is_mine} head={sender} text={source} onClick={onShowMessage ? showQuoted : undefined} preview />
  </ChatReplyQuote> : preview
}
