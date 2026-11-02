import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus, GroupChatSettings, GroupCollabSnapshot, GroupMemberRole, ListenMode } from '@gugu/core/shared/types/chat'
import { MoreHorizontal, Plus, UserPlus } from '@/lib/icons'
import { chatService } from '../../lib/chat'
import { UI_EVENTS } from '../../lib/uiEvents'
import { groupAgentDisplayStatus } from '../../lib/groupAgentStatus'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'
import { canEditAgentListenMode, canInviteHumansToGroup, isProjectGroupChat } from '../../lib/groupMemberPermissions'
import type { DisplayIdentity } from '../../lib/displayIdentity'
import { MemberProfilePopover } from '../MemberProfilePopover'
import type { MemberProfileCardModel, MemberProfileChatTarget, MemberProfileEditControls } from '../MemberProfileCard'
import { type ActiveMemberProfile, agentOwnerDisplayName, toAgentProfile, toHumanProfile } from '../memberProfileModels'
import { IconButton } from '../ui/IconButton'
import { Hint } from '../ui/Tooltip'
import { Menu, MenuItem } from '../ui/Menu'
import { AddGroupMembers } from './AddGroupMembers'
import { InviteButton } from './InviteButton'
import { useMobileShell } from '../../hooks/useMobileShell'
import { closeInfoTab } from '../../session/renderer/features/chats/chat-tabs/chat-layouts'
import { settingsErrorStyle } from './groupSettingsStyles'

// @@@6418 群成员面板里「和人有关的操作」:邀请、点开资料卡(角色 / 倾听模式 / 移出 / 发消息 / 悄悄话)、
// 行尾 ⋯ 快捷管理。原来这些只在设置抽屉的头像网格里有,面板只能看;现在面板是成员的唯一入口。
// 群和话题共用资料/移出;邀请与角色修改只在来源群。管理权限来自后端,owner-agent 控件独立。
// 入群申请❌ 在这里:申请是冲着人来的请求,和好友申请同归通讯录「新的请求」(NewFriendsPanel)。

const errorStyle: CSSProperties = { ...settingsErrorStyle, padding: '4px 14px' }

export function useGroupMemberPanelControls({ chatId, chatKind, settings, snapshot, identities, agentStatuses, currentUserId, onReload, onOpenUserChat, onWhisper }: {
  chatId: string
  chatKind: 'group' | 'topic'
  settings: GroupChatSettings | null
  snapshot: GroupCollabSnapshot | null
  identities: Readonly<Record<string, DisplayIdentity>>
  agentStatuses: Record<string, AgentDisplayStatus>
  currentUserId: string | null
  onReload: () => Promise<void>
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onWhisper?: (target: MemberProfileChatTarget) => void
}) {
  const { t } = useTranslation('messaging')
  const viewerRole = settings?.my_role ?? null
  const viewerIsManager = settings?.can_manage === true
  const isGroup = chatKind === 'group'
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeProfile, setActiveProfile] = useState<ActiveMemberProfile | null>(null)
  const [menu, setMenu] = useState<{ memberId: string; anchor: Element } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setActiveProfile(null); setMenu(null) }, [chatId])

  const openPicker = useCallback(() => setPickerOpen(true), [])

  const shownAgent = useShownAgentStatus() // #7199 资料卡画的那一格:宿主闲时收回着 ≠ 不在线
  const profileOf = useCallback((memberId: string): MemberProfileCardModel | null => {
    if (!snapshot) return null
    const identity = identities[memberId]
    if (!identity) return null
    const human = snapshot.humans.find((member) => member.id === memberId)
    if (human) return toHumanProfile(human, identity)
    const agent = snapshot.agents.find((member) => member.id === memberId)
    if (agent) return toAgentProfile(agent, identity, shownAgent.status(agent.id, groupAgentDisplayStatus(agent, agentStatuses)), agentOwnerDisplayName(identity, identities))
    return null
  }, [agentStatuses, identities, shownAgent, snapshot])

  const runMutation = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      await onReload()
      return true
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
      // @@@2247 失败后按权威名册重读:删不掉的幽灵行靠 allow-shrink 自愈,没权限的成员留着、错误显示出来。
      void onReload()
      return false
    } finally {
      setBusy(false)
    }
  }, [onReload])

  const canManage = useCallback((profile: MemberProfileCardModel) => (
    viewerIsManager && (!isGroup || profile.role !== 'owner') && profile.id !== currentUserId
  ), [currentUserId, isGroup, viewerIsManager])
  // Owners retain agent departure rights; listen-mode management is a separate permission.
  const ownsAgent = useCallback((profile: MemberProfileCardModel) => (
    !!currentUserId && profile.type === 'agent' && profile.ownerUserId === currentUserId
  ), [currentUserId])
  const canEditListenMode = useCallback((profile: MemberProfileCardModel) => (
    canEditAgentListenMode(profile, currentUserId, settings)
  ), [currentUserId, settings])
  const isSelfLeaving = useCallback((profile: MemberProfileCardModel) => (
    chatKind === 'topic' && profile.id === currentUserId
  ), [chatKind, currentUserId])

  const setRole = useCallback((profile: MemberProfileCardModel, role: GroupMemberRole) => (
    runMutation(() => chatService.setGroupMemberRole(chatId, profile.id, role))
  ), [chatId, runMutation])
  const setListenMode = useCallback((profile: MemberProfileCardModel, mode: ListenMode) => (
    runMutation(() => chatService.setAgentListenMode(chatId, profile.id, mode))
  ), [chatId, runMutation])
  const remove = useCallback(async (profile: MemberProfileCardModel) => {
    if (await runMutation(() => chatService.removeGroupMember(chatId, profile.id))) setActiveProfile(null)
  }, [chatId, runMutation])

  const editControlsFor = useCallback((profile: MemberProfileCardModel): MemberProfileEditControls | undefined => {
    const manageable = canManage(profile)
    const owned = ownsAgent(profile)
    const self = isSelfLeaving(profile)
    if (!manageable && !owned && !self && !canEditListenMode(profile)) return undefined
    return {
      canChangeRole: isGroup && manageable,
      onChangeRole: isGroup && manageable ? (role) => { void setRole(profile, role) } : undefined,
      onChangeListenMode: canEditListenMode(profile) ? (mode) => { void setListenMode(profile, mode) } : undefined,
      canRemove: manageable || owned || self,
      removeLabel: self ? t('group.settings.leave') : undefined,
      onRemove: () => remove(profile),
      busy,
      editError: error,
    }
  }, [busy, canEditListenMode, canManage, error, isGroup, isSelfLeaving, ownsAgent, remove, setListenMode, setRole, t])

  const openProfile = useCallback((memberId: string, anchor: Element) => {
    const profile = profileOf(memberId)
    if (!profile) return
    setError(null)
    setMenu(null)
    setActiveProfile({ member: profile, anchor, preferredSide: 'left', openedFrom: 'aside' })
  }, [profileOf])

  // 名册变了(改角色 / 改档位)要让已打开的卡跟着变:每次渲染按最新名册重建卡片模型。
  const renderedProfile = useMemo(() => {
    if (!activeProfile) return null
    const member = profileOf(activeProfile.member.id)
    return member ? { ...activeProfile, member } : null
  }, [activeProfile, profileOf])
  const menuProfile = menu ? profileOf(menu.memberId) : null

  // 项目群不拉人类进来:「邀请」还在(加自己的 agent),人类那一页换成原因。
  const projectGroup = isProjectGroupChat(chatId)
  const canInvite = isGroup && !projectGroup && canInviteHumansToGroup(settings)
  // 普通成员在不许邀人的群里仍能加自己的 Agent(picker 的 Agent 页签);所以只要是群成员就给入口。
  const showInvite = isGroup && Boolean(viewerRole)

  // 新建一个 Agent 直接进这个群:谁都能把自己的 Agent 加进群(同上),所以入口跟「邀请」一起给。
  // 桌面上群输入框的「新任务」就是这件事(gugu-dev#181),这里只留给手机。
  const mobile = useMobileShell()
  const createAgentInGroup = useCallback(() => {
    if (mobile) closeInfoTab(chatId)
    window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
  }, [chatId, mobile])

  const headerActions: ReactNode = showInvite && mobile ? (
    <InviteButton icon={<Plus />} label={t('group.memberList.createAgent')} onClick={createAgentInGroup} testId="member-list-create-agent" />
  ) : null
  const inviteAction: ReactNode = showInvite ? (
    <Hint label={t('group.memberList.invite')} side="bottom">
      <IconButton aria-label={t('group.memberList.invite')} onClick={openPicker} data-testid="member-list-invite">
        <UserPlus />
      </IconButton>
    </Hint>
  ) : null

  const rowActions = useCallback((memberId: string): ReactNode => {
    const profile = profileOf(memberId)
    if (!profile || (!canManage(profile) && !ownsAgent(profile) && !isSelfLeaving(profile) && !canEditListenMode(profile))) return null
    return (
      // 有 hover 的设备:行悬停/聚焦时才显形,隐藏时连点击一起关掉(看不见的钮不许点得到)。
      // 没有 hover 的触屏:一直显示 —— 否则管理者在手机上永远找不到它。
      <span
        className="pointer-events-none opacity-0 group-hover/member-row:pointer-events-auto group-hover/member-row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 data-[open]:pointer-events-auto data-[open]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
        data-open={menu?.memberId === memberId || undefined}
      >
        <IconButton size="sm" aria-label={t('group.memberList.manage', { name: profile.displayName })} on={menu?.memberId === memberId}
          onClick={(event) => { event.stopPropagation(); setMenu({ memberId, anchor: event.currentTarget }) }}>
          <MoreHorizontal />
        </IconButton>
      </span>
    )
  }, [canEditListenMode, canManage, isSelfLeaving, menu?.memberId, ownsAgent, profileOf, t])

  const errorLine: ReactNode = error && !activeProfile
    ? <div role="alert" style={errorStyle}>{error}</div>
    : null

  const overlays: ReactNode = (
    <>
      {menu && menuProfile ? (
        <Menu anchor={menu.anchor} minWidth={160} onClose={() => setMenu(null)} ariaLabel={t('group.memberList.manage', { name: menuProfile.displayName })}>
          {isGroup && canManage(menuProfile) ? (
            <MenuItem onClick={() => { setMenu(null); void setRole(menuProfile, menuProfile.role === 'admin' ? 'member' : 'admin') }}>
              {menuProfile.role === 'admin' ? t('group.memberList.revokeAdmin') : t('group.memberList.makeAdmin')}
            </MenuItem>
          ) : null}
          {canEditListenMode(menuProfile) ? (
            <MenuItem onClick={() => { setMenu(null); void setListenMode(menuProfile, menuProfile.listenMode === 'active' ? 'passive' : 'active') }}>
              {menuProfile.listenMode === 'active' ? t('group.memberList.setPassive') : t('group.memberList.setActive')}
            </MenuItem>
          ) : null}
          {canManage(menuProfile) || ownsAgent(menuProfile) || isSelfLeaving(menuProfile) ? (
            <MenuItem danger onClick={() => { setMenu(null); void remove(menuProfile) }}>
              {isSelfLeaving(menuProfile) ? t('group.settings.leave') : ownsAgent(menuProfile) ? t('group.memberList.agentLeave') : t('group.settings.removeMemberTitle')}
            </MenuItem>
          ) : null}
        </Menu>
      ) : null}
      {renderedProfile ? (
        <MemberProfilePopover
          profile={renderedProfile}
          onClose={() => setActiveProfile(null)}
          onOpenChat={renderedProfile.member.id !== currentUserId && onOpenUserChat ? (target) => {
            setActiveProfile(null)
            if (mobile) closeInfoTab(chatId)
            onOpenUserChat(target)
          } : undefined}
          onWhisper={renderedProfile.member.id !== currentUserId && onWhisper ? (target) => { setActiveProfile(null); onWhisper(target) } : undefined}
          editControls={editControlsFor(renderedProfile.member)}
        />
      ) : null}
      {pickerOpen && snapshot ? (
        <AddGroupMembers
          chatId={chatId}
          snapshot={snapshot}
          canInviteHumans={canInvite}
          humanDeniedHint={projectGroup ? t('group.projectGroupNoInvite') : undefined}
          onClose={() => setPickerOpen(false)}
          onReload={onReload}
        />
      ) : null}
    </>
  )

  return { headerActions, inviteAction, rowActions, openProfile, overlays, errorLine, activeMemberId: renderedProfile?.member.id ?? null }
}
