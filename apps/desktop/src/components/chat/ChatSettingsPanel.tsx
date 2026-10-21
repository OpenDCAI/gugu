import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus, ChatItem, GroupCollabSnapshot, MessageItem, NotificationLevel } from '@gugu/core/shared/types/chat'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import type { MemberProfileCardModel, MemberProfileChatTarget } from '../MemberProfileCard'
import { MemberProfileAvatarButton } from '../MemberProfileAvatarButton'
import { MemberProfilePopover } from '../MemberProfilePopover'
import type { ActiveMemberProfile } from '../memberProfileModels'
import { GroupMembersSection } from './GroupMembersSection'
import { GroupAgentFloodSettings } from './GroupAgentFloodSettings'
import { ChatManagementActions } from './ChatManagementActions'
import { RightPanel } from './RightPanel'
import { SettingsPageHead } from './groupSettingsUi'
import { COLOR_MUTED } from './chatPresentation'

// 从 ChatAreaPanel 拆出来的(那份文件行数冻结,#7199 给它加「吃一个会话 id」时腾的位置),内容原样。
// 会话/群设置:桌面是右栏(RightPanel,与成员列表、群公告同一个外壳同一个槽位),手机是整页。
export type ChatSettingsPanelProps = ChatRightPanelBodyProps & { mobile?: boolean }

export function ChatSettingsPanel({ mobile = false, ...body }: ChatSettingsPanelProps) {
  const { activeChat, onClose } = body
  const { t } = useTranslation('messaging')
  // 群设置的页头在 GroupMembersSection 自己的页面栈里;私聊没有,这里补同一个页头(手机 = 左上返回)。
  const content = (
    <>
      {activeChat.kind === 'group' ? null : <SettingsPageHead title={t('chatArea.settings.conversation')} onClose={onClose} mobile={mobile} />}
      <ChatRightPanelBody {...body} />
    </>
  )
  // 手机上 RightPanel 自己是整页(@@@6418);返回键由页头 SettingsPageHead 接,外壳不再接一次。
  return <RightPanel scroll testId="chat-settings-panel">{content}</RightPanel>
}

interface ChatRightPanelBodyProps {
  activeChat: ChatItem
  messages: MessageItem[]
  onClose: () => void
  onClearMessages: () => Promise<void>
  onOpenSearch: () => void
  onSetNotificationLevel: (level: NotificationLevel) => Promise<void>
  onTogglePinned: (pinned: boolean) => Promise<void>
  memberProfiles: MemberProfileCardModel[]
  currentUserId: string | null
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  // @@@whisper (#820) — 悄悄话回调透传到内部 MemberProfilePopover。
  onWhisper?: (target: MemberProfileChatTarget) => void
  groupCollabSnapshot: GroupCollabSnapshot
  groupAgentStatuses: Record<string, AgentDisplayStatus>
  onReloadGroupCollab: () => Promise<void>
  onLeaveGroup: () => Promise<void>
  onDissolveGroup: () => Promise<void>
}

// @@@right-panel-body - One right-side surface for DM + group + mobile. Members section differs by chat
// kind (group gets the rich role-switching list, DM keeps the simple peer card), then ChatManagementActions.
function ChatRightPanelBody({ activeChat, onClose, onClearMessages, onOpenSearch, onSetNotificationLevel, onTogglePinned, memberProfiles, currentUserId, onOpenUserChat, onWhisper, groupCollabSnapshot, onReloadGroupCollab, onLeaveGroup, onDissolveGroup }: ChatRightPanelBodyProps) {
  const { t } = useTranslation('messaging')
  const [activeProfile, setActiveProfile] = useState<ActiveMemberProfile | null>(null)
  const isGroupChat = activeChat.kind === 'group'

  useEffect(() => {
    setActiveProfile(null)
  }, [activeChat.id])

  const drawerProfiles = memberProfiles

  const MAX_SHOWN = 9
  const shownMembers = drawerProfiles.slice(0, MAX_SHOWN)
  const overflow = drawerProfiles.length - MAX_SHOWN

  return (
    <>
      {isGroupChat ? (
        <GroupMembersSection
          chat={activeChat}
          snapshot={groupCollabSnapshot}
          currentUserId={currentUserId}
          onReload={onReloadGroupCollab}
          onClose={onClose}
          onLeaveGroup={onLeaveGroup}
          onDissolveGroup={onDissolveGroup}
          onOpenUserChat={onOpenUserChat}
          onWhisper={onWhisper}
          onOpenSearch={onOpenSearch}
          onSetNotificationLevel={onSetNotificationLevel}
          onTogglePinned={onTogglePinned}
          onClearMessages={onClearMessages}
        />
      ) : (
        <>
          <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)', padding: '12px 14px 6px', userSelect: 'none' }}>{t('chatArea.settings.members')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '0 14px 10px' }}>
            {shownMembers.map((m) => (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                <MemberProfileAvatarButton
                  member={m}
                  testId={AUTOMATION_TEST_IDS.chatDrawerProfileButton}
                  avatarSize="sm"
                  buttonSize={38}
                  active={activeProfile?.member.id === m.id}
                  onOpen={(event) => {
                    setActiveProfile({
                      member: m,
                      anchor: event.currentTarget,
                      preferredSide: 'left',
                    })
                  }}
                />
                <span style={{ fontSize: '10px', color: COLOR_MUTED, maxWidth: '36px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {m.displayName}
                </span>
              </div>
            ))}
            {overflow > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' }}>
                <div
                  style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: 'var(--radius-document)',
                    background: 'var(--bg-elevated)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 'var(--font-caption)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  +{overflow}
                </div>
              </div>
            )}
          </div>
          <div style={{ height: '1px', background: 'var(--border-color)', flexShrink: 0, margin: '4px 0' }} />
          <div className="px-3"><GroupAgentFloodSettings key={activeChat.id} chatId={activeChat.id} /></div>
          <ChatManagementActions
            activeChat={activeChat}
            onClose={onClose}
            onClearMessages={onClearMessages}
            onOpenSearch={onOpenSearch}
            onSetNotificationLevel={onSetNotificationLevel}
            onTogglePinned={onTogglePinned}
          />
        </>
      )}
      {activeProfile ? (
        <MemberProfilePopover
          profile={activeProfile}
          onClose={() => setActiveProfile(null)}
          onOpenChat={activeProfile.member.id !== currentUserId && onOpenUserChat ? (target) => {
            setActiveProfile(null)
            onOpenUserChat(target)
          } : undefined}
          onWhisper={onWhisper ? (target) => {
            setActiveProfile(null)
            onWhisper(target)
          } : undefined}
          testId={AUTOMATION_TEST_IDS.chatDrawerProfileMenu}
        />
      ) : null}
    </>
  )
}
