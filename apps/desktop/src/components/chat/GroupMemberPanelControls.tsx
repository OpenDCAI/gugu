import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentDisplayStatus, GroupCollabSnapshot, GroupMemberRole, ListenMode } from '@gugu/core/shared/types/chat'
import { MoreHorizontal, UserPlus } from '@/lib/icons'
import { chatService } from '../../lib/chat'
import { UI_EVENTS } from '../../lib/uiEvents'
import { groupAgentDisplayStatus } from '../../lib/groupAgentStatus'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'
import { canInviteHumansToGroup, isGroupManagerRole, isProjectGroupChat } from '../../lib/groupMemberPermissions'
import type { DisplayIdentity } from '../../lib/displayIdentity'
import { MemberProfilePopover } from '../MemberProfilePopover'
import type { MemberProfileCardModel, MemberProfileChatTarget, MemberProfileEditControls } from '../MemberProfileCard'
import { type ActiveMemberProfile, agentOwnerDisplayName, toAgentProfile, toHumanProfile } from '../memberProfileModels'
import { IconButton } from '../ui/IconButton'
import { Button } from '../ui/Button'
import { Menu, MenuItem } from '../ui/Menu'
import { AddGroupMembers } from './AddGroupMembers'
import { useMobileShell } from '../../hooks/useMobileShell'
import { settingsErrorStyle } from './groupSettingsStyles'

// @@@6418 群成员面板里「和人有关的操作」:邀请、点开资料卡(角色 / 倾听模式 / 移出 / 发消息 / 悄悄话)、
// 行尾 ⋯ 快捷管理。原来这些只在设置抽屉的头像网格里有,面板只能看;现在面板是成员的唯一入口。
// 只对群生效(话题的名单与邀请走 TopicMemberInviteButton,角色/移出在话题里没有语义)。
// 入群申请❌ 在这里:申请是冲着人来的请求,和好友申请同归通讯录「新的请求」(NewFriendsPanel)。

const errorStyle: CSSProperties = { ...settingsErrorStyle, padding: '4px 14px' }

export function useGroupMemberPanelControls({ chatId, enabled, snapshot, identities, agentStatuses, currentUserId, onReload, onOpenUserChat, onWhisper }: {
  chatId: string
  enabled: boolean
  snapshot: GroupCollabSnapshot | null
  identities: Readonly<Record<string, DisplayIdentity>>
  agentStatuses: Record<string, AgentDisplayStatus>
  currentUserId: string | null
  onReload: () => Promise<void>
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onWhisper?: (target: MemberProfileChatTarget) => void
}) {
  const { t } = useTranslation('messaging')
  const viewerRole = snapshot?.humans.find((human) => human.id === currentUserId)?.role ?? null
  const viewerIsManager = enabled && isGroupManagerRole(viewerRole)
  const [allowMemberInvite, setAllowMemberInvite] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [activeProfile, setActiveProfile] = useState<ActiveMemberProfile | null>(null)
  const [menu, setMenu] = useState<{ memberId: string; anchor: Element } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setActiveProfile(null); setMenu(null); setAllowMemberInvite(false) }, [chatId])

  // 「谁能拉人类」:群主/管理员随时能拉;普通成员要看群的 allow_member_invite(#854)。
  // 只在普通成员点「邀请」时才去读这个字段 —— 面板打开时不读群设置(阈值等设置项不属于这块面板,#5999)。
  // 读不到就 fail-loud 并按不能拉人类处理(picker 仍能加自己的 Agent)。
  const openPicker = useCallback(() => {
    if (isGroupManagerRole(viewerRole)) { setPickerOpen(true); return }
    setError(null)
    chatService.getGroupChatSettings(chatId)
      .then((settings) => { setAllowMemberInvite(settings.allow_member_invite) })
      .catch((err: unknown) => {
        setAllowMemberInvite(false)
        setError(t('group.settings.loadFailed', { reason: String((err as Error)?.message ?? err) }))
      })
      .finally(() => setPickerOpen(true))
  }, [chatId, t, viewerRole])

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
    viewerIsManager && profile.role !== 'owner' && profile.id !== currentUserId
  ), [currentUserId, viewerIsManager])
  // 自己的 agent:档位只有主人能改(群主 / 管理员也不行),主人也能让它退群。库里同一条规则。
  const ownsAgent = useCallback((profile: MemberProfileCardModel) => (
    enabled && !!currentUserId && profile.type === 'agent' && profile.ownerUserId === currentUserId
  ), [currentUserId, enabled])

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
    if (!manageable && !owned) return undefined
    return {
      canChangeRole: manageable,
      onChangeRole: manageable ? (role) => { void setRole(profile, role) } : undefined,
      // @@@1208 倾听模式:只有 agent 的主人能改,与消息头像卡同一口径。
      onChangeListenMode: owned ? (mode) => { void setListenMode(profile, mode) } : undefined,
      canRemove: manageable || owned,
      onRemove: () => remove(profile),
      busy,
      editError: error,
    }
  }, [busy, canManage, error, ownsAgent, remove, setListenMode, setRole])

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
  const canInvite = enabled && !projectGroup && canInviteHumansToGroup({ viewerRole, allowMemberInvite })
  // 普通成员在不许邀人的群里仍能加自己的 Agent(picker 的 Agent 页签);所以只要是群成员就给入口。
  const showInvite = enabled && Boolean(viewerRole)

  // 新建一个 Agent 直接进这个群:谁都能把自己的 Agent 加进群(同上),所以入口跟「邀请」一起给。
  // 桌面上群输入框的「新任务」就是这件事(gugu-dev#181),这里只留给手机。
  const mobile = useMobileShell()
  const createAgentInGroup = useCallback(() => {
    window.dispatchEvent(new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } }))
  }, [chatId])

  const headerActions: ReactNode = showInvite ? (
    <>
      {mobile && (
        <Button size="sm" variant="ghost" data-testid="member-list-create-agent" onClick={createAgentInGroup}>
          {t('group.memberList.createAgent')}
        </Button>
      )}
      <IconButton size="sm" aria-label={t('group.memberList.invite')} title={t('group.memberList.invite')} data-testid="member-list-invite" onClick={openPicker}>
        <UserPlus />
      </IconButton>
    </>
  ) : null

  const rowActions = useCallback((memberId: string): ReactNode => {
    const profile = profileOf(memberId)
    if (!profile || (!canManage(profile) && !ownsAgent(profile))) return null
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
  }, [canManage, menu?.memberId, ownsAgent, profileOf, t])

  const errorLine: ReactNode = enabled && error && !activeProfile
    ? <div role="alert" style={errorStyle}>{error}</div>
    : null

  const overlays: ReactNode = enabled ? (
    <>
      {menu && menuProfile ? (
        <Menu anchor={menu.anchor} minWidth={160} onClose={() => setMenu(null)} ariaLabel={t('group.memberList.manage', { name: menuProfile.displayName })}>
          {canManage(menuProfile) ? (
            <MenuItem onClick={() => { setMenu(null); void setRole(menuProfile, menuProfile.role === 'admin' ? 'member' : 'admin') }}>
              {menuProfile.role === 'admin' ? t('group.memberList.revokeAdmin') : t('group.memberList.makeAdmin')}
            </MenuItem>
          ) : null}
          {ownsAgent(menuProfile) ? (
            <MenuItem onClick={() => { setMenu(null); void setListenMode(menuProfile, menuProfile.listenMode === 'active' ? 'passive' : 'active') }}>
              {menuProfile.listenMode === 'active' ? t('group.memberList.setPassive') : t('group.memberList.setActive')}
            </MenuItem>
          ) : null}
          <MenuItem danger onClick={() => { setMenu(null); void remove(menuProfile) }}>
            {ownsAgent(menuProfile) ? t('group.memberList.agentLeave') : t('group.settings.removeMemberTitle')}
          </MenuItem>
        </Menu>
      ) : null}
      {renderedProfile ? (
        <MemberProfilePopover
          profile={renderedProfile}
          onClose={() => setActiveProfile(null)}
          onOpenChat={renderedProfile.member.id !== currentUserId && onOpenUserChat ? (target) => { setActiveProfile(null); onOpenUserChat(target) } : undefined}
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
  ) : null

  return { headerActions, rowActions, openProfile, overlays, errorLine, activeMemberId: renderedProfile?.member.id ?? null }
}
