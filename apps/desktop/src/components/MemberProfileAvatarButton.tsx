import { Avatar } from './Avatar'
import type { AutomationTestId } from '../lib/automationDom'
import type { MemberProfileCardModel } from './MemberProfileCard'
import { useTranslation } from 'react-i18next'

export function MemberProfileAvatarButton({
  member,
  testId,
  avatarSize = 'sm',
  buttonSize = 34,
  active = false,
  isAgent = member.type === 'agent',
  messageSenderId,
  onOpen,
}: {
  member: MemberProfileCardModel
  testId: AutomationTestId
  avatarSize?: 'sm' | 'md'
  buttonSize?: number
  active?: boolean
  isAgent?: boolean
  messageSenderId?: string
  onOpen: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  const { t } = useTranslation('contacts')
  return (
    <button
      type="button"
      className="gg-pressable"
      data-testid={testId}
      data-group-member-id={member.id}
      data-group-member-type={member.type}
      data-group-member-role={member.role}
      data-message-sender-id={messageSenderId}
      data-profile-member-id={member.id}
      data-profile-member-type={member.type}
      data-profile-member-role={member.role}
      aria-label={t('profile.viewProfile', { name: member.displayName })}
      aria-expanded={active}
      onClick={(event) => {
        event.stopPropagation()
        onOpen(event)
      }}
      style={{
        width: buttonSize,
        height: buttonSize,
        border: active ? '1px solid var(--accent)' : '1px solid transparent',
        borderRadius: avatarSize === 'md' ? 7 : 8,
        background: active ? 'var(--accent-tint-row)' : 'transparent',
        color: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        cursor: 'pointer',
        flexShrink: 0,
      }}
    >
      <Avatar
        name={member.displayName}
        avatarUrl={member.avatar}
        seed={member.id}
        size={avatarSize}
        isAgent={isAgent}
        agentStatus={member.agentStatus}
      />
    </button>
  )
}
