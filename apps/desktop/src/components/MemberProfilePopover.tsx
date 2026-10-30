import { AUTOMATION_TEST_IDS, type AutomationTestId } from '../lib/automationDom'
import { MemberProfileCard, type MemberProfileChatTarget, type MemberProfileEditControls } from './MemberProfileCard'
import type { ActiveMemberProfile } from './memberProfileModels'
import { useContactsStore } from '../store/contactsContext'
import { useAuth } from '../store/auth'
import { useChatStore } from '../store/chatContext'
import { useMobileShell } from '../hooks/useMobileShell'
import { Popover } from './ui/Popover'
import { Sheet } from './ui/Sheet'
import { useTranslation } from 'react-i18next'

const adjacentSettingsSelector = '[data-testid="sidebar-profile-button"], [data-testid="sidebar-profile-menu"], [data-testid="sidebar-settings-nav"], [data-testid="settings-panel"]'

function isAdjacentSettingsTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(adjacentSettingsSelector) !== null
}

export function MemberProfilePopover({
  profile,
  onClose: _onClose,
  onOpenChat,
  onWhisper,
  findMessagesOf,
  editControls,
  testId = AUTOMATION_TEST_IDS.groupMemberProfileMenu,
}: {
  profile: ActiveMemberProfile
  onClose: () => void
  onOpenChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 透传给 MemberProfileCard 的悄悄话回调。
  onWhisper?: (target: MemberProfileChatTarget) => void
  /** globalSearch.v3: search this member's messages in the conversation the card was opened from. */
  findMessagesOf?: (userId: string) => void
  editControls?: MemberProfileEditControls
  testId?: AutomationTestId
}) {
  const { t } = useTranslation('contacts')
  const { user } = useAuth()
  const { identitiesById } = useChatStore('identitiesById')
  // Width matches design .pop { width:284px }
  const width = 284
  const gap = 10
  const { contacts, updateContactAlias } = useContactsStore()
  const contact = contacts.find((item) => item.id === profile.member.id)
  const aliasControls = contact
    ? { alias: contact.alias ?? null, onSave: (alias: string) => updateContactAlias(contact.id, alias) }
    : undefined
  const isSelf = user?.id === profile.member.id
  const bio = profile.member.bio ?? (isSelf ? user.bio : contact?.bio) ?? null
  const email = profile.member.email ?? (isSelf ? user.email : null)
  const displayName = identitiesById[profile.member.id]?.display_name ?? profile.member.displayName
  const enrichedMember = bio !== profile.member.bio || email !== profile.member.email || displayName !== profile.member.displayName
    ? { ...profile.member, displayName, bio, email }
    : profile.member
  const side = profile.preferredSide ?? 'left'
  const mobile = useMobileShell()
  const ariaLabel = t('profile.profileDialog', { name: displayName })
  const card = <MemberProfileCard member={enrichedMember} onOpenChat={onOpenChat} onWhisper={onWhisper} onFindMessages={findMessagesOf ? () => { _onClose(); findMessagesOf(enrichedMember.id) } : undefined} editControls={editControls} aliasControls={aliasControls} fill={mobile} />
  const memberData = { 'data-profile-member-id': profile.member.id, 'data-profile-member-type': profile.member.type, 'data-profile-member-role': profile.member.role }

  // 手机是共用的底部面板(#6836):贴着锚点的 284 宽卡片在整行宽的成员页上左右都放不下,会整张落在屏外。
  if (mobile) {
    return (
      <Sheet onClose={_onClose} mobileFitContent testId={testId} ariaLabel={ariaLabel}>
        <div {...memberData}>{card}</div>
      </Sheet>
    )
  }

  // @@@no-close-x - Base UI handles outside press + Escape; the corner X was redundant.
  return (
    <Popover.Root
      open
      modal={false}
      onOpenChange={(open, eventDetails) => {
        if (open) return
        const nextTarget = eventDetails.event instanceof FocusEvent
          ? eventDetails.event.relatedTarget
          : null
        const opensAdjacentSettings = (eventDetails.reason === 'outside-press' || eventDetails.reason === 'focus-out')
          && (isAdjacentSettingsTarget(eventDetails.event.target) || isAdjacentSettingsTarget(nextTarget))
        if (opensAdjacentSettings) {
          eventDetails.cancel()
          return
        }
        _onClose()
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          anchor={profile.anchor}
          positionMethod="fixed"
          side={side}
          align="start"
          sideOffset={gap}
          alignOffset={-8}
          collisionPadding={8}
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
        >
          <Popover.Popup
            role="dialog"
            aria-label={ariaLabel}
            data-testid={testId}
            {...memberData}
            style={{ width }}
          >
            {card}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
