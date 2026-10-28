// @@@5856 成员面板 —— 产品预期见 product spec「成员与响应档位」。
//
// 群和话题**共用这一个面板**:话题的名单可以比来源窄,但读法一模一样 —— 名单就是这条 chat 自己的
// chat_members,所以这里只认 chatId,不认它是从哪儿长出来的。
//
// spec 逐条落在哪:
//   · 「按人 / Agent 分两段」→ 下面两个 <Section>,段内限高可滚(长列表自动出全局细滚动条)。#2178 ③④
//   · 「每个 agent 一行显示引擎、模型、跑在哪,以及响应档位」→ AgentRow。
//
// 数据与 fail-loud(❌ 不写死、❌ 不编占位值):
//   · 名单由宿主的 useGroupCollabLoader 提供:已有快照先画,权威刷新不清空字段。
//   · 引擎:权威快照的 group_agent_states.client 目前全产品没有写者(永远 null),所以引擎退回**联系人档**
//     的 agent_type —— 与单聊头栏取引擎的来源是同一个(ChatAreaPanel「单聊 Agent 的联系人档」)。
//     这条来源**只覆盖主人自己的 agent**:别人的 agent 不在主人通讯录里,那一格就空着。
//   · 模型(model_source)/设备取不到 ⇒ **那一格不渲染**,让「空」看得出是空。
//     ❌ 不拿「未知引擎」「默认模型」这类占位值糊上去 —— 空得看得出是空,才知道是数据缺了。
//   · 在线态复用 agent presence 这份现成真值(useAgentDisplayStatuses → Avatar 角标),#2178 ②。
//     **人这一段没有在线态**:产品里压根没有「某个人在不在线」的真值(聊天列表、通讯录的绿点都只画 agent),
//     所以这一格不显 —— ❌ 不拿 desired_status 这类 agent 字段冒充人的在线。
import { GroupNameInlineEdit } from './GroupNameInlineEdit'
import { Button } from '../ui/Button'
import { Hint } from '../ui/Tooltip'
import { SectionLabel } from '../ui/SectionLabel'
import { SearchField } from '../ui/SearchField'
import { HeaderSearch } from '../ui/HeaderSearch'
import { useMobileShell } from '../../hooks/useMobileShell'
import type { MemberProfileChatTarget } from '../MemberProfileCard'
import { useGroupMemberPanelControls } from './GroupMemberPanelControls'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { agentLocationText, resolveAgentLocation } from '../../lib/agentRunningStatusModels'
import type {
  AgentDisplayStatus,
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupMemberRole,
  ListenMode,
} from '@gugu/core/shared/types/chat'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import { getAgentTypeLabel, nullableAgentType } from '@gugu/core/shared/enums/agentTypeModels'
import { Avatar } from '../Avatar'
import { AgentOwnerLabel } from '../AgentOwnerLabel'
import { chatService } from '../../lib/chat'
import { groupAgentDisplayStatus } from '../../lib/groupAgentStatus'
import type { DisplayIdentity } from '../../lib/displayIdentity'
import { useAgentDisplayStatuses } from '../../hooks/useAgentDisplayStatus'
import { useShownAgentStatus } from './useAgentsOnCloudComputer'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'
import { useContactsStore } from '../../store/contactsContext'
import { useDevicesStore } from '../../store/devicesContext'
import { agentOwnerDisplayName, toAgentProfile } from '../memberProfileModels'
import { buildUnifiedMembers } from './groupMemberModels'
import { useListenModeEditControls } from './useListenModeEditControls'
import { ChevronRight } from '../../lib/icons'
import type { UseGroupCollabLoaderResult } from '../../hooks/useGroupCollabLoader'




const sectionHeaderStyle = {
  display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
  padding: '12px 14px 4px', color: 'var(--text-tertiary)',
  fontSize: 'var(--font-caption)', fontWeight: 600, letterSpacing: '.02em',
} as const

// gugu-dev#181「我的 agent · N」那一行的折叠箭头。
const myAgentsChevronStyle = (open: boolean): React.CSSProperties => ({
  width: 14, height: 14, flexShrink: 0, transform: open ? 'rotate(90deg)' : undefined,
})

const metaCellStyle = {
  fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160,
} as const

// @@@ui-ruler 其余结构性 style 一并提到模块作用域(同 ChatListPanel 的 *_STYLE 常量):
// 既避免每次渲染重建对象,也让 JSX 里不再残留内联几何块这条债务痕迹。
// 依赖 props/state 的那一档提成纯函数,保持同一条纪律。
// 档位是一行淡字(❌ 带框的胶囊:看着像按钮);说明在悬停浮层里。主人点它照旧翻档。
const listenModeToggleStyle = (editable: boolean): React.CSSProperties => ({
  padding: 0, minHeight: 0, height: 'auto', flexShrink: 0, fontWeight: 400,
  fontSize: 'var(--font-caption)', lineHeight: 1.2, color: 'var(--text-tertiary)',
  cursor: editable ? 'pointer' : 'default',
})
// 「我的 agent」与「其他人的 agent」两组同级:后一组顶上一条分隔线,折叠的那组底下也一眼看得出边界。
const OTHER_AGENTS_GROUP_STYLE: React.CSSProperties = { borderTop: '1px solid var(--border-subtle)', marginTop: 4 }
const MEMBER_ROW_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 10, padding: '7px 14px' }
// @@@6418 群里的行可以点开资料卡;行尾的 ⋯ 管理钮靠 group-hover 显形。
const MEMBER_ROW_INTERACTIVE_STYLE: React.CSSProperties = { ...MEMBER_ROW_STYLE, cursor: 'pointer' }
const MEMBER_ROW_ACTIONS_STYLE: React.CSSProperties = { flexShrink: 0, alignSelf: 'center' }
const MEMBER_LIST_SEARCH_STYLE: React.CSSProperties = { padding: '10px 14px 2px', flexShrink: 0 }
const MEMBER_LIST_EMPTY_STYLE: React.CSSProperties = { padding: '24px 14px', textAlign: 'center', fontSize: 'var(--font-body)', color: 'var(--text-tertiary)' }
const MEMBER_ROW_BODY_STYLE: React.CSSProperties = { minWidth: 0, flex: 1, alignSelf: 'center' }
const MEMBER_ROW_NAME_LINE_STYLE: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }
const MEMBER_ROW_NAME_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-body)', color: 'var(--text-primary)', fontWeight: 500,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
}
const MEMBER_ROW_ROLE_STYLE: React.CSSProperties = {
  fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)',
  padding: '0 4px', flexShrink: 0,
}
const MEMBER_ROW_META_CELLS_STYLE: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: '2px 10px', marginTop: 3 }
const MEMBER_ROW_TRAILING_STYLE: React.CSSProperties = { marginTop: 6 }
const MEMBER_LIST_PANEL_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }
const MEMBER_LIST_TITLE_STYLE: React.CSSProperties = { fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)' }
// 话题改名那一格:占满标题与右侧动作之间的余量。与本文件其余样式同形走常量 ——
// ❌ 不就地写内联样式块(check-ui-visual-spec 的那条棘轮是纯文本计数,连注释里的字面量都算)。
const TOPIC_NAME_EDIT_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 }
const MEMBER_LIST_ERROR_STYLE: React.CSSProperties = { padding: '10px 14px', color: 'var(--danger)', fontSize: 'var(--font-caption)' }
// 档位没改成的原因:写在那一行的档位钮下面。
const MEMBER_ROW_ERROR_STYLE: React.CSSProperties = { marginTop: 4, color: 'var(--danger)', fontSize: 'var(--font-caption)' }
const MEMBER_LIST_SCROLL_STYLE: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto' }

/**
 * 倾听档位。@@@5856 档位收成两档之后,这里从「一排分段按钮」改成**一枚开关**:
 * 两个值的东西不需要两个按钮占一整行 —— 那条灰底三连在视觉上不协调。
 * 现在一行只留当前档位本身,点一下就翻到另一档。
 * 变更走 useListenModeEditControls 那条**现成**的 mutation(chat_members.listen_mode);
 * 不是这个 agent 的主人拿不到 editControls ⇒ 这里就是只读镜像,点不动。
 */
function ListenModeToggle({
  value,
  onChange,
  busy,
}: {
  value: ListenMode
  onChange?: (mode: ListenMode) => void
  busy?: boolean
}) {
  const { t } = useTranslation('messaging')
  const editable = !!onChange
  const next: ListenMode = value === 'passive' ? 'active' : 'passive'
  const mode = value === 'passive' ? 'mentions' : 'all'
  return (
    <Hint label={t(`group.memberList.listen.${mode}Hint`)} side="top">
      <Button
        variant="ghost"
        size="sm"
        data-listen-mode-toggle={value}
        aria-pressed={value === 'active'}
        disabled={editable ? busy : undefined}
        // 群里整行可点(打开资料卡);档位钮自己的点击不能再冒泡成「打开资料卡」。
        onClick={editable ? (event) => { event.stopPropagation(); onChange?.(next) } : undefined}
        style={listenModeToggleStyle(editable)}
      >
        {t(`group.memberList.listen.${mode}`)}
      </Button>
    </Hint>
  )
}

function MemberRow({
  memberId,
  identity,
  isAgent,
  roleLabel,
  statusBadge,
  metaCells,
  trailing,
  onOpen,
  actions,
  selected,
}: {
  memberId: string
  identity: DisplayIdentity | undefined
  isAgent: boolean
  roleLabel: string | null
  statusBadge?: AgentDisplayStatus
  metaCells?: ReactNode
  trailing?: ReactNode
  /** 群:点行打开资料卡(anchor = 这一行)。话题没有这一格。 */
  onOpen?: (anchor: Element) => void
  actions?: ReactNode
  selected?: boolean
}) {
  // 名册里有这个 id、身份却没跟上来 —— 这是数据层该出而没出的值,照 GroupMemberAvatarRow 的做法喊出来,
  // ❌ 不静默补一个「未知用户」。
  const diagnostic = identity ? null : resolveOrLoud(undefined, `member list identity ${memberId}`)
  return (
    <div
      data-member-row={memberId}
      data-member-kind={isAgent ? 'agent' : 'human'}
      className={onOpen ? 'gg-row group/member-row' : undefined}
      data-selected={selected || undefined}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen ? (event) => onOpen(event.currentTarget) : undefined}
      onKeyDown={onOpen ? (event) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(event.currentTarget) } } : undefined}
      style={onOpen ? MEMBER_ROW_INTERACTIVE_STYLE : MEMBER_ROW_STYLE}
    >
      <Avatar
        name={identity?.display_name ?? ''}
        avatarUrl={identity?.avatar ?? null}
        seed={memberId}
        size="sm"
        isAgent={isAgent}
        agentStatus={statusBadge}
      />
      <div style={MEMBER_ROW_BODY_STYLE}>
        <div style={MEMBER_ROW_NAME_LINE_STYLE}>
          <span
            data-member-name={memberId}
            style={MEMBER_ROW_NAME_STYLE}
          >
            {identity?.display_name ?? diagnostic}
          </span>
          {roleLabel ? (
            <span
              data-member-role={memberId}
              style={MEMBER_ROW_ROLE_STYLE}
            >
              {roleLabel}
            </span>
          ) : null}
        </div>
        {metaCells ? (
          <div style={MEMBER_ROW_META_CELLS_STYLE}>{metaCells}</div>
        ) : null}
        {trailing ? <div style={MEMBER_ROW_TRAILING_STYLE}>{trailing}</div> : null}
      </div>
      {actions ? <div style={MEMBER_ROW_ACTIONS_STYLE}>{actions}</div> : null}
    </div>
  )
}

export type MemberListPanelProps = {
  chatId: string
  /** 群和话题都用这一个面板;话题的成员名单可以比来源窄。 */
  chatKind: 'group' | 'topic'
  /** 页头归宿主画(群设置栈 / 👥 右栏 / 话题分栏各画各的);这里只给标题与标题旁的动作。 */
  head: (title: ReactNode, actions: ReactNode) => ReactNode
  /**
   * 话题的当前名字。spec 把「名字可改」当成「建立只有一步」的**理由**
   * (「创建时要决定的每一项都能从上下文推出来,且都可以事后改」),所以改名入口不能缺 ——
   * 缺了之后,系统消息/附件开出来的那条永远叫「话题」,开两次就是两行同名。
   * 群不走这里:群名在设置抽屉里改(GroupMembersSection),❌ 不做第二个入口。
   */
  chatName?: string | null
  /** @@@6418 群:名册被这里改动(邀请/移出/改角色/审批)后通知外层重读它自己的那份快照。 */
  snapshot: GroupCollabSnapshot | null
  error?: UseGroupCollabLoaderResult['error']
  onReload: () => Promise<void>
  onOpenUserChat?: (target: MemberProfileChatTarget) => void
  onWhisper?: (target: MemberProfileChatTarget) => void
}

export function MemberListPanel({ chatId, chatKind, head, chatName, snapshot, error, onReload: load, onOpenUserChat, onWhisper }: MemberListPanelProps) {
  const { t } = useTranslation('messaging')
  const { t: tContacts } = useTranslation('contacts')
  const { user } = useAuth()
  const { identitiesById: identities } = useChatStore('identitiesById')
  const { devices } = useDevicesStore()
  const { contacts } = useContactsStore()
  // The conversation owns the roster. Opening this drawer only requests a quiet refresh.
  useEffect(() => { void load() }, [load])

  const agents = useMemo<GroupAgentItem[]>(() => snapshot?.agents ?? [], [snapshot])
  const agentIds = useMemo(() => agents.map((agent) => agent.id), [agents])
  const agentStatuses = useAgentDisplayStatuses(agentIds)
  const shownAgent = useShownAgentStatus() // #7199 角标 / 资料画的那一格:宿主闲时收回着 ≠ 不在线
  const unified = useMemo(
    () => (snapshot ? buildUnifiedMembers(snapshot) : []),
    [snapshot],
  )
  const people = useMemo(() => unified.filter((member) => member.type === 'human'), [unified])
  const agentMembers = useMemo(() => unified.filter((member) => member.type === 'agent'), [unified])

  const group = useGroupMemberPanelControls({
    chatId,
    enabled: chatKind === 'group',
    snapshot,
    identities,
    agentStatuses,
    currentUserId: user?.id ?? null,
    onReload: load,
    onOpenUserChat,
    onWhisper,
  })

  // @@@6418 搜索:名字、主人、引擎、模型、设备,与行上看得见的字一致(看不见的字段不参与匹配)。
  const [query, setQuery] = useState('')
  const [myAgentsExpanded, setMyAgentsExpanded] = useState(true)
  const mobile = useMobileShell()
  useEffect(() => { setQuery('') }, [chatId])

  // 只有 agent 的主人拿得到可交互的档位控件 —— 判断与 mutation 都在这个现成 hook 里,这里不复制一份。
  const resolveEditControls = useListenModeEditControls({
    chatId,
    currentUserId: user?.id ?? null,
    onReload: load,
  })

  // 改名:落库口径与群名同一条(chats_update_owner 要 owner/admin),所以能不能改直接问同一个 hook。
  // create_topic 把创建者置为 owner,所以开话题的人总改得动自己那条。
  const [renamed, setRenamed] = useState<string | null>(null)
  const topicName = renamed ?? chatName ?? null
  // 落库口径是 chats_update_owner,要 owner/admin。
  const viewerIsManager = useMemo(() => {
    const role = snapshot?.humans.find((human) => human.id === user?.id)?.role ?? null
    return role === 'owner' || role === 'admin'
  }, [snapshot, user?.id])
  const canRenameTopic = chatKind === 'topic' && viewerIsManager
  const handleRenameTopic = useCallback(async (next: string) => {
    const updated = await chatService.updateGroupChatSettings(chatId, { name: next })
    setRenamed(updated.name ?? next)
  }, [chatId])

  // 引擎:先认权威快照,取不到再退回主人的联系人档(见文件头「引擎」那条)。
  const engineLabel = useCallback((agent: GroupAgentItem): string | null => {
    if (agent.client) return agent.client
    const agentType = nullableAgentType(contacts.find((contact) => contact.id === agent.id)?.agent_type)
    return agentType ? getAgentTypeLabel(agentType) : null
  }, [contacts])

  const deviceLabel = useCallback((identity: DisplayIdentity | undefined): string | null => {
    // 与聊天标题栏、会话列表同一个判据与叫法(本机 / 咕咕云 / 设备名)。
    return agentLocationText(resolveAgentLocation(identity?.device_id, devices), t)
  }, [devices, t])

  // 普通成员不写「成员」(人人都是);只有群主、管理员这类特殊角色才标。
  const roleLabel = useCallback((role: GroupMemberRole): string | null => (
    role === 'owner'
      ? tContacts('profile.roles.owner')
      : role === 'admin' ? tContacts('profile.roles.admin') : null
  ), [tContacts])

  const needle = query.trim().toLowerCase()
  const matchesQuery = (values: ReadonlyArray<string | null | undefined>) => (
    !needle || values.some((value) => value?.toLowerCase().includes(needle))
  )
  const shownPeople = people.filter((member) => matchesQuery([identities[member.id]?.display_name]))
  const shownAgents = agentMembers.filter((member) => {
    const agent = member.raw as GroupAgentItem
    const identity = identities[agent.id]
    return matchesQuery([
      identity?.display_name,
      identity ? agentOwnerDisplayName(identity, identities) : null,
      engineLabel(agent),
      agent.model_source,
      deviceLabel(identity),
    ])
  })
  const nothingMatches = Boolean(needle) && shownPeople.length === 0 && shownAgents.length === 0
  // gugu-dev#181:一个任务一个 agent,群里我的 agent 越开越多 ⇒ 收成一组「我的 agent · N」,点开再看;搜索时摊开。
  const myAgents = shownAgents.filter((member) => identities[member.id]?.owner_user_id === user?.id)
  const otherAgents = shownAgents.filter((member) => identities[member.id]?.owner_user_id !== user?.id)
  const myAgentsOpen = myAgentsExpanded || Boolean(needle)
  const setMyAgentsOpen = setMyAgentsExpanded
  const renderAgentRow = (member: (typeof shownAgents)[number]) => {
    const agent = member.raw as GroupAgentItem
    const identity = identities[agent.id]
    const device = deviceLabel(identity)
    const engine = engineLabel(agent)
    const controls = identity
      ? resolveEditControls(toAgentProfile(
          agent,
          identity,
          shownAgent.status(agent.id, groupAgentDisplayStatus(agent, agentStatuses)),
          agentOwnerDisplayName(identity, identities),
        ))
      : undefined
    return (
      <MemberRow
        key={agent.id}
        memberId={agent.id}
        identity={identity}
        isAgent
        roleLabel={roleLabel(agent.role)}
        statusBadge={shownAgent.status(agent.id, groupAgentDisplayStatus(agent, agentStatuses))}
        onOpen={chatKind === 'group' ? (anchor) => group.openProfile(agent.id, anchor) : undefined}
        actions={chatKind === 'group' ? group.rowActions(agent.id) : undefined}
        selected={group.activeMemberId === agent.id}
        metaCells={(
          <>
            {/* 自己的 agent 已在「我的 agent」组里,不再写一遍主人。 */}
            {identity?.owner_user_id === user?.id ? null : <span data-agent-meta="owner" style={metaCellStyle}><AgentOwnerLabel ownerUserId={identity?.owner_user_id} ownerDisplayName={identity ? agentOwnerDisplayName(identity, identities) : null} /></span>}
            {/* 取不到就整格不渲染 —— 空得看得出来,❌ 没有「未知引擎」这种占位。 */}
            {engine ? <span data-agent-meta="engine" style={metaCellStyle}>{engine}</span> : null}
            {agent.model_source ? <span data-agent-meta="model" style={metaCellStyle}>{agent.model_source}</span> : null}
            {device ? <span data-agent-meta="device" style={metaCellStyle}>{device}</span> : null}
          </>
        )}
        trailing={(
          <>
            <ListenModeToggle
              value={agent.listen_mode}
              onChange={controls?.onChangeListenMode
                ? (mode) => { void controls.onChangeListenMode?.(mode) }
                : undefined}
              busy={controls?.busy}
            />
            {controls?.editError ? <div role="alert" data-listen-mode-error={agent.id} style={MEMBER_ROW_ERROR_STYLE}>{controls.editError}</div> : null}
          </>
        )}
      />
    )
  }

  return (
    <>
      <div
        data-testid="member-list-panel"
        data-chat-kind={chatKind}
        style={MEMBER_LIST_PANEL_STYLE}
      >
        <HeaderSearch mobile={mobile} value={query} onChange={setQuery} placeholder={t('group.memberList.search')} testId="member-list-search">{(searchButton) => head(
          chatKind === 'topic' ? (
            <>
              <span style={MEMBER_LIST_TITLE_STYLE}>{t('group.memberList.titleTopic')}</span>
              <div style={TOPIC_NAME_EDIT_STYLE} data-testid="topic-name-edit">
                <GroupNameInlineEdit
                  name={topicName}
                  canEdit={canRenameTopic}
                  onCommit={handleRenameTopic}
                  labels={{
                    editHint: t('group.renameHintTopic'),
                    placeholder: t('group.renamePlaceholderTopic'),
                  }}
                />
              </div>
            </>
          ) : t('group.memberList.title'),
          <>
            {searchButton}
            {group.headerActions}
          </>,
        )}</HeaderSearch>

        {snapshot && !mobile ? (
          <div style={MEMBER_LIST_SEARCH_STYLE}>
            <SearchField
              data-testid="member-list-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('group.memberList.search')}
              clearLabel={t('group.memberList.clearSearch')}
              onClear={() => setQuery('')}
            />
          </div>
        ) : null}

        {group.errorLine}

        {error ? (
          <div
            data-testid="member-list-error"
            data-member-list-error={error}
            style={MEMBER_LIST_ERROR_STYLE}
          >
            {error === 'not-participant'
              ? t('group.memberList.notParticipant')
              : t('group.memberList.loadFailed')}
          </div>
        ) : null}

        <div data-member-list-scroll="" style={MEMBER_LIST_SCROLL_STYLE}>
          {nothingMatches ? (
            <div data-testid="member-list-no-match" style={MEMBER_LIST_EMPTY_STYLE}>{t('group.memberList.noMatches', { query: query.trim() })}</div>
          ) : null}
          {needle && shownPeople.length === 0 ? null : (
          <section data-member-section="human">
            <div style={sectionHeaderStyle}>
              <span>{t('group.memberList.sectionPeople')}</span>
              <span aria-hidden="true">{shownPeople.length}</span>
            </div>
            {/* 段内❌ 不再自己限高自己滚。面板本身就是滚动容器(MEMBER_LIST_SCROLL_STYLE),
                里面再套一个限高的滚动框 = 第二条滚动轴:6 个 agent 一共 468px 撞上 420px 的顶,
                最后一行被切掉半截,而外面那层还空着三百多像素(owner 2026-09-19 实测截图)。
                #2178 的两条要求由外面那一层兑现 —— ①「有 N 个就滚得到 N 个」、④长列表出细滚动条。 */}
            <div data-member-section-rows="human">
              {shownPeople.map((member) => (
                <MemberRow
                  key={member.id}
                  memberId={member.id}
                  identity={identities[member.id]}
                  isAgent={false}
                  roleLabel={roleLabel((member.raw as GroupMemberItem).role)}
                  // 在线态:人这一侧产品里没有真值 ⇒ 不给角标(❌ 不编一个「在线」出来)。
                  statusBadge={undefined}
                  onOpen={chatKind === 'group' ? (anchor) => group.openProfile(member.id, anchor) : undefined}
                  actions={chatKind === 'group' ? group.rowActions(member.id) : undefined}
                  selected={group.activeMemberId === member.id}
                />
              ))}
            </div>
          </section>
          )}

          {needle && shownAgents.length === 0 ? null : (
          <section data-member-section="agent">
            <div style={sectionHeaderStyle}>
              <span>{t('group.memberList.sectionAgents')}</span>
              <span aria-hidden="true">{shownAgents.length}</span>
            </div>
            <div data-member-section-rows="agent">
              {myAgents.length > 0 ? (
                <div data-member-group="mine">
                  <SectionLabel
                    interactive
                    role="button"
                    tabIndex={0}
                    aria-expanded={myAgentsOpen}
                    leading={<ChevronRight aria-hidden="true" style={myAgentsChevronStyle(myAgentsOpen)} />}
                    onClick={() => setMyAgentsOpen((open) => !open)}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setMyAgentsOpen((open) => !open) } }}
                  >
                    {t('group.memberList.myAgents', { count: myAgents.length })}
                  </SectionLabel>
                  {myAgentsOpen ? myAgents.map(renderAgentRow) : null}
                </div>
              ) : null}
              {otherAgents.length > 0 ? (
                <div data-member-group="others" style={myAgents.length > 0 ? OTHER_AGENTS_GROUP_STYLE : undefined}>
                  {myAgents.length > 0 ? <SectionLabel leading={<span aria-hidden="true" style={myAgentsChevronStyle(false)} />}>{t('group.memberList.otherAgents', { count: otherAgents.length })}</SectionLabel> : null}
                  {otherAgents.map(renderAgentRow)}
                </div>
              ) : null}
            </div>
          </section>
          )}
        </div>
      </div>
      {group.overlays}
    </>
  )
}
