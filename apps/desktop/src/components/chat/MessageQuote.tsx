import type { MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { composerCardPreview } from '@gugu/core/shared/ui/taskCardModels'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { ComposerCardHead } from './ComposerCardView'

/**
 * 气泡里引的那一条:谁说的 + 原话,点一下跳到被引用的消息。
 * 引的是一张任务卡(gugu-dev#181):第一行是卡头「✳ 新任务」(谁的卡不用说,卡上有),第二行是原话。
 */
export function MessageQuote({ msg, quoterIsAgent, memberProfiles, onShowMessage }: {
  msg: MessageItem
  onShowMessage?: (id: string) => void
  /** 引卡的是 agent(它回群时引自己那张卡):卡头画它的标。 */
  quoterIsAgent: boolean
  memberProfiles?: Record<string, MemberProfileCardModel>
}) {
  const { t } = useTranslation('messaging')
  const quotedCard = composerCardPreview(msg.reply_to_content)
  const showQuoted = (event: MouseEvent) => {
    event.stopPropagation()
    if (msg.reply_to_message_id) onShowMessage?.(msg.reply_to_message_id)
  }
  return (
    <div role={onShowMessage ? "button" : undefined} title={t('message.showQuoted')} onClick={onShowMessage ? showQuoted : undefined} style={{
      cursor: onShowMessage ? 'pointer' : 'inherit',
      display: 'inline-block',
      overflow: 'hidden',
      borderLeft: `3px solid ${msg.is_mine ? 'var(--bubble-quote-bar-mine)' : 'var(--bubble-quote-bar-other)'}`,
      paddingLeft: '7px',
      maxWidth: '180px',
    }}>
      <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', fontWeight: 600, opacity: 0.6, marginBottom: '1px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {quotedCard ? <ComposerCardHead type={quotedCard.type} agentUserId={quoterIsAgent ? msg.sender_user_id : null} />
          : resolveOrLoud(memberProfiles?.[msg.reply_to_sender_user_id ?? '']?.displayName, `reply sender ${msg.reply_to_message_id ?? msg.id}`)}
      </div>
      <div style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', opacity: 0.55, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {quotedCard ? quotedCard.text : msg.reply_to_content ?? ''}
      </div>
    </div>
  )
}
