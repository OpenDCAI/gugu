import { useTranslation } from 'react-i18next'
import { Chip } from '../ui/Chip'
import { Button } from '../ui/Button'
import { notify } from '../../lib/notices'
import { useAuth } from '../../store/auth'
import { BODY_COLORS } from '../agentAvatar/engine/identity'
import { resolveAgentLook } from '../agentAvatar/look'
import type { MemberProfileCardModel } from '../MemberProfileCard'
import { fmtMsgTime } from './messageRowTime'
import './messageBubbleChrome.css'

// 气泡自己的「谁说的 / 什么时候」(owner 10-25「名字进气泡、时间进右下角」,照 Telegram):
// 名字在气泡第一行、小一号、按这个人的颜色;时间在气泡右下角,和最后一行正文同一行。

/** 群里收到的消息、组首那一条:名字 + 归属小标签(「我的 agent」「Alice 的 agent」)。
 *  颜色不另起色板:用身份层按 id 定下的那一档色相(agent 形象的身体色,agent 改过形象就跟着它),亮度/彩度随主题(tokens.css)。 */
export function BubbleSender({ member, senderId, compact = false }: { compact?: boolean; member: MemberProfileCardModel | null; senderId: string | null }) {
  const { t } = useTranslation('messaging')
  const { user } = useAuth()
  const hue = BODY_COLORS[resolveAgentLook(senderId, member?.avatar ?? null).color].hue
  const tag = member?.type !== 'agent' ? null
    : member.ownerUserId && member.ownerUserId === user?.id ? t('message.myAgentTag')
    : member.ownerDisplayName ? t('message.agentOwnerTag', { owner: member.ownerDisplayName })
    : t('message.agentOwnerUnavailableTag')
  return (
    <div data-message-sender-id={compact ? senderId ?? undefined : undefined} data-message-who="true" data-message-sender-name="true" className={compact ? "msg-sender msg-sender-compact" : "msg-sender"} style={{ '--member-hue': hue } as React.CSSProperties}>
      {compact && member?.type === 'agent' && senderId ? (
        <Button variant="ghost" className="msg-sender-name msg-sender-link" onClick={() => {
          void import('./openAgentSession').then(({ openAgentSession }) => openAgentSession(senderId))
            .catch((error: unknown) => notify({ tier: 'error', title: error instanceof Error ? error.message : String(error) }))
        }}>{member.displayName}</Button>
      ) : <span className="msg-sender-name">{member?.displayName ?? ''}</span>}
      {!compact && tag && <Chip appearance="filled" data-message-agent-owner="true">{tag}</Chip>}
    </div>
  )
}

/** 气泡右下角的时间。inline = 和最后一行正文同一行(正文末尾由 .msg-time-room 留出位子);否则单独占气泡最后一行。 */
export function BubbleTime({ iso, isMine, inline }: { iso: string; isMine: boolean; inline: boolean }) {
  return <span data-message-time="true" data-mine={isMine || undefined} data-inline={inline || undefined} className="msg-time">{fmtMsgTime(iso)}</span>
}
