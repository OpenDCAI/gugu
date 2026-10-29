import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ContactGroupChat, ContactUser } from '@gugu/core/shared/types/contacts'
import { AddFriendSearch } from '@/components/AddFriendSearch'
import { Avatar } from '@/components/Avatar'
import { NewFriendsPanel } from '@/components/NewFriendsPanel'
import { ContactDetail } from '@/components/contacts/ContactDetail'
import { AgentContactRow } from '@/components/contacts/AgentContactRow'
import { peopleContacts } from '@/components/contacts/contactSelectors'
import { GroupInviteJoinModal } from '@/components/contacts/GroupInvite'
import { rowKeyActivate } from '@/components/contacts/contactsPanelStyles'
import { Button } from '@/components/ui/Button'
import { Chip } from '@/components/ui/Chip'
import { HeaderSearch } from '@/components/ui/HeaderSearch'
import { ListRow } from '@/components/ui/ListRow'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { displayName } from '@/lib/contactsListSort'
import { ChevronRight, Search, UserPlus } from '@/lib/icons'
import type { QrScanRoute } from '@/lib/qrScanRoute'
import { RETAINED_SURFACE_HIDDEN_STYLE } from '@/lib/retainedSurface'
import { navigateMobile } from '@/mobile/navigateMobile'
import { PhoneMeButton } from '@/mobile/PhoneMeButton'
import { useMachineLabel } from '@/mobile/agent-watch/useMachineLabel'
import { directoryMachines } from '@/mobile/agent-watch/machine-list'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import type { AuthUser } from '@/store/auth'
import { useContactsStore } from '@/store/contactsContext'
import { useDevicesStore } from '@/store/devicesContext'
import { useToast } from '@/components/toastContext'
import { messageForUser } from '@/lib/userFacingError'
import { projectRpcOn } from './projectRpc'
import { matchesQuery, partnerFriends, partnerGroupAgents, partnerProjects, projectSessions, runningCount, type PartnerProject } from './partnersModel'
import { PhoneNewProjectPage, type CreatedProject } from './PhoneNewProjectPage'
import { PhoneProjectContacts } from './PhoneProjectContacts'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'
import './partners.css'

/** 推在「伙伴」首页上的一页:整屏、没有底栏,返回一步回到下面那一页。 */
type PartnersPage =
  | { kind: 'requests' }
  | { kind: 'add'; seed: { query: string; token: number } | null }
  | { kind: 'friend'; contactId: string }
  | { kind: 'project'; key: string; created?: CreatedProject }
  | { kind: 'newProject'; fromOutside: boolean }

/** 入口行:ContactsPanel NavButton 的手机几何(44 高、20 图标、16 字、计数、尾部 ›)。 */
function NavRow({ icon, label, badge, testId, onClick }: { icon: ReactNode; label: string; badge?: number; testId?: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="option" className="gg-partners-navrow" data-testid={testId} onClick={onClick}>
      <span className="gg-partners-navrow-icon">{icon}</span>
      <span className="gg-partners-navrow-label">{label}</span>
      {badge ? <Chip tone="danger" shape="count">{badge > 99 ? '99+' : badge}</Chip> : null}
      <ChevronRight size={16} aria-hidden className="gg-partners-navrow-chevron" />
    </Button>
  )
}

/**
 * 手机「伙伴」一格(OpenDCAI/gugu#446,v7.12 稿;桌面仍是 ContactsPanel):新的请求、添加联系人两行入口,下面是项目(文件夹)
 * 和朋友(只列人),群里遇到的别人的 Agent 单独列,复用桌面 Agent 库的行。项目按建的先后、一行只有名字;
 * 项目和朋友没有状态、没有提醒(那归「消息」),普通群也不在这里。
 * 点进去的几页整屏推进来(没有底栏),由 onPushedChange 告诉外壳收起底栏。
 */
export function PhonePartnersPage({
  user,
  active,
  externalContactId,
  scanSeed,
  newProjectRequest,
  onOpenMe,
  onPushedChange,
  onLeave,
  onSwitchToChat,
  onOpenGroupChat,
  onOpenProjectGroup,
}: {
  user: AuthUser
  /** 「伙伴」这一格此刻在屏上(切走 = 回到首页)。 */
  active: boolean
  externalContactId?: string
  scanSeed?: { route: QrScanRoute; token: number } | null
  /** 「消息」右上「新项目」:每次加一就推进新项目页。 */
  newProjectRequest?: number
  onOpenMe: () => void
  onPushedChange: (pushed: boolean) => void
  /** 从「消息」进来的新项目页退回去:回到「消息」。 */
  onLeave: () => void
  onSwitchToChat?: (target: ContactUser) => void
  onOpenGroupChat?: (group: ContactGroupChat) => void
  /** 打开项目群(落在群聊页签)。 */
  onOpenProjectGroup: (chatId: string) => void
}) {
  const { t } = useTranslation('main')
  const { t: ct } = useTranslation('contacts')
  const { contacts, sharedGroupAgents, groupChats, pendingRequestCount, sentRequests, sendRequest, setAgentPublic, setAgentDesiredStatus, getCommonGroupChats } = useContactsStore()
  const { devices } = useDevicesStore()
  const { isHome } = useMachineLabel()
  const liveSessions = useLiveDeviceSessions()
  const { toast } = useToast()
  const [stack, setStack] = useState<PartnersPage[]>([])
  const [query, setQuery] = useState('')
  const [requestingAgentId, setRequestingAgentId] = useState<string | null>(null)
  const [groupInviteJoin, setGroupInviteJoin] = useState<{ publicId: number; joinToken?: string; token: number } | null>(null)
  const top = stack.at(-1) ?? null

  const push = useCallback((page: PartnersPage) => navigateMobile(() => setStack((current) => [...current, page]), 'push'), [])
  const pop = useCallback(() => navigateMobile(() => setStack((current) => current.slice(0, -1)), 'pop'), [])

  useEffect(() => { onPushedChange(stack.length > 0) }, [stack.length, onPushedChange])
  // 常驻在横滑分页器里:切走这一格就回到首页(同 ContactsPanel #6730)。
  useEffect(() => { if (!active) setStack([]) }, [active])
  useEffect(() => {
    if (!externalContactId) return
    setStack([{ kind: 'friend', contactId: externalContactId }])
  }, [externalContactId])
  // 扫码:一个人的咕咕号 → 添加联系人并带上它;群邀请 → 入群确认(同 ContactsPanel @@@scan-seed)。
  useEffect(() => {
    if (!scanSeed) return
    const { route } = scanSeed
    if (route.nav === 'group_join') setGroupInviteJoin({ publicId: route.publicId, joinToken: route.joinToken, token: Date.now() })
    else setStack([{ kind: 'add', seed: { query: route.query, token: Date.now() } }])
  }, [scanSeed])
  useEffect(() => {
    if (!newProjectRequest) return
    setStack([{ kind: 'newProject', fromOutside: true }])
  }, [newProjectRequest])

  const machines = useMemo(() => directoryMachines(devices, isHome), [devices, isHome])
  const projects = useMemo(() => partnerProjects(machines), [machines])
  const sessionsOf = useCallback((deviceId: string) => {
    const device = machines.find((row) => row.device_id === deviceId)
    return device ? deviceSessionsOf(device, liveSessions).sessions : []
  }, [machines, liveSessions])
  const friends = useMemo(() => partnerFriends(contacts), [contacts])
  const groupAgents = useMemo(() => partnerGroupAgents(contacts, sharedGroupAgents, user.id), [contacts, sharedGroupAgents, user.id])
  const sentRequestIds = useMemo(() => new Set(sentRequests.map((request) => request.receiver_id)), [sentRequests])
  const humanContacts = useMemo(() => peopleContacts(contacts), [contacts])
  const requestAgent = useCallback(async (agent: ContactUser) => {
    if (requestingAgentId) return
    setRequestingAgentId(agent.id)
    try {
      await sendRequest(agent.id)
    } finally {
      setRequestingAgentId(null)
    }
  }, [requestingAgentId, sendRequest])

  // 还没绑群的项目(从没开过会话):先让它所在的那台机器把群备好再进(同电脑项目一摆上屏就补上群)。
  const openProjectGroup = async (project: PartnerProject) => {
    if (project.chatId) {
      onOpenProjectGroup(project.chatId)
      return
    }
    const member = project.members.find((candidate) => machines.some((row) => row.device_id === candidate.deviceId && row.is_online))
    const device = member ? machines.find((row) => row.device_id === member.deviceId) : undefined
    if (!member || !device) {
      toast(t('partners.groupOffline'), 'error')
      return
    }
    try {
      const result = await projectRpcOn(device).projects.ensureProjectGroup(member.localProjectId)
      if (!result.success) throw new Error(result.error.message)
      onOpenProjectGroup(result.data.chatId)
    } catch (error) {
      toast(t('partners.groupUnavailable'), 'error', messageForUser(error))
    }
  }

  const shownProjects = projects.filter((project) => matchesQuery(project.name, query))
  const shownFriends = friends.filter((friend) => matchesQuery(displayName(friend), query))
  const shownGroupAgents = groupAgents.filter(agent => matchesQuery(displayName(agent), query))
  const searching = query.trim() !== ''

  const projectPage = (page: Extract<PartnersPage, { kind: 'project' }>) => {
    const created = page.created
    const project: PartnerProject | null = projects.find((candidate) => candidate.key === page.key)
      // 刚建的项目:账号上那一份还没刷到,先照建的时候知道的画。
      ?? (created ? { key: page.key, chatId: created.chatId, name: created.name, createdAt: created.createdAt, coverId: created.localProjectId, members: [{ deviceId: created.deviceId, localProjectId: created.localProjectId }] } : null)
    if (!project) return null
    const sessions = projectSessions(project, sessionsOf)
    return (
      <PhoneProjectContacts
        project={project}
        running={runningCount(sessions)}
        sessions={sessions}
        active={active}
        onBack={pop}
        onOpenGroup={() => void openProjectGroup(project)}
      />
    )
  }

  const pushed = (() => {
    if (!top) return null
    switch (top.kind) {
      case 'requests':
        return <NewFriendsPanel onOpenGroupChat={onOpenGroupChat} onBack={pop} />
      case 'add':
        return <AddFriendSearch seed={top.seed} autoFocus showHeader onBack={pop} />
      case 'friend': {
        const contact = contacts.find((item) => item.id === top.contactId) ?? sharedGroupAgents.find((item) => item.id === top.contactId) ?? null
        return (
          <ContactDetail
            contact={contact}
            humanContacts={humanContacts}
            sentRequestIds={sentRequestIds}
            requestingAgentId={requestingAgentId}
            groupChats={groupChats}
            mobile
            onBack={pop}
            onSwitchToChat={onSwitchToChat}
            onOpenGroupChat={onOpenGroupChat}
            onRequestAgent={requestAgent}
            onSetAgentPublic={setAgentPublic}
            onSetAgentDesiredStatus={setAgentDesiredStatus}
            getCommonGroupChats={getCommonGroupChats}
          />
        )
      }
      case 'project':
        return projectPage(top)
      case 'newProject':
        return (
          <PhoneNewProjectPage
            active={active}
            onBack={top.fromOutside && stack.length === 1 ? onLeave : pop}
            // 建好了:新项目页换成它的通讯录,返回回到「伙伴」首页(新项目就在列表里)。
            onCreated={(created) => navigateMobile(() => setStack([{ kind: 'project', key: created.chatId ?? `${created.deviceId}:${created.localProjectId}`, created }]), 'replace')}
          />
        )
    }
  })()

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="phone-partners">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" style={top ? RETAINED_SURFACE_HIDDEN_STYLE : undefined}>
        <Pane paneRole="nav" mobile className="gg-partners" data-phone-root-list="contacts">
          <HeaderSearch mobile externalTrigger="contacts" active={active && !top} value={query} onChange={setQuery} placeholder={t('partners.search')} testId="phone-partners-search">
            {(searchButton) => (
              <PaneHeader mobile titleLevel="page" title={<span data-first-run-hint="collaboration" data-first-run-device="phone">{t('shell.partnersMobile')}</span>} leading={<PhoneMeButton user={user} onOpen={onOpenMe} />} actions={searchButton} />
            )}
          </HeaderSearch>
          <div data-first-run-hint-space="collaboration" />
          <div className="gg-partners-scroll">
            {!searching ? (
              <div className="gg-partners-navrows">
                <NavRow icon={<UserPlus size={20} />} label={ct('panel.newRequests')} badge={pendingRequestCount} testId="phone-partners-requests" onClick={() => push({ kind: 'requests' })} />
                <NavRow icon={<Search size={20} />} label={ct('panel.addContact')} testId="phone-partners-add" onClick={() => push({ kind: 'add', seed: null })} />
              </div>
            ) : null}
            <div className="gg-partners-list">
              {shownProjects.length ? <SectionLabel>{t('partners.projects', { count: shownProjects.length })}</SectionLabel> : null}
              {shownProjects.map((project) => {
                const open = () => push({ kind: 'project', key: project.key })
                return (
                  <ListRow key={project.key} mobile role="button" tabIndex={0} data-testid="phone-partners-project"
                    leading={<ProjectFolderAvatar coverId={project.coverId} running={runningCount(projectSessions(project, sessionsOf))} />}
                    title={project.name} onClick={open} onKeyDown={rowKeyActivate(open)} />
                )
              })}
              {shownFriends.length ? <SectionLabel>{t('partners.friends', { count: shownFriends.length })}</SectionLabel> : null}
              {shownFriends.map((friend) => {
                const open = () => push({ kind: 'friend', contactId: friend.id })
                return (
                  <ListRow key={friend.id} mobile role="button" tabIndex={0} data-testid="phone-partners-friend"
                    leading={<Avatar name={displayName(friend)} avatarUrl={friend.avatar} seed={friend.id} size="md" harnessBadge={false} />}
                    title={displayName(friend)} onClick={open} onKeyDown={rowKeyActivate(open)} />
                )
              })}
              {shownGroupAgents.length ? <SectionLabel>{t('partners.groupAgents', { count: shownGroupAgents.length })}</SectionLabel> : null}
              {shownGroupAgents.map(agent => (
                <AgentContactRow key={agent.id} contact={agent} mobile selected={false} testId="phone-partners-group-agent"
                  onSelect={() => push({ kind: 'friend', contactId: agent.id })} />
              ))}
              {searching && !shownProjects.length && !shownFriends.length && !shownGroupAgents.length ? <div className="gg-partners-empty">{t('partners.noResults')}</div> : null}
            </div>
          </div>
        </Pane>
      </div>
      {pushed}
      {groupInviteJoin ? (
        <GroupInviteJoinModal key={groupInviteJoin.token} publicId={groupInviteJoin.publicId} joinToken={groupInviteJoin.joinToken} onClose={() => setGroupInviteJoin(null)} />
      ) : null}
    </div>
  )
}
