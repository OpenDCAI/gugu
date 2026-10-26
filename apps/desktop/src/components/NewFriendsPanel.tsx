import { GroupInvitationsPanel } from './contacts/GroupInvitationsPanel'
import { messageForUser } from '../lib/userFacingError'
import { Button } from './ui/Button'
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import { useContactsStore } from '../store/contactsContext'
import { resolveOrLoud } from '@gugu/core/shared/resolveOrLoud'
import type { ContactGroupChat } from '@gugu/core/shared/types/contacts'
import { Avatar } from './Avatar'
import { AUTOMATION_TEST_IDS } from '../lib/automationDom'
import { SegmentedTabs } from './ui/SegmentedTabs'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useChatStore } from '../store/chatContext'
import { chatService } from '../lib/chat'
import { rendererLogger } from '../lib/log'
import type { ManagedGroupJoinRequest } from '../lib/groupJoinRequests'
import { awaitsMe, friendRequestStatusKey, type FriendRequestEntry } from '../lib/requestHistory'
import { RequestDetailSheet } from './requests/RequestDetailSheet'
import { useBackLayer } from './ui/sheetStack'

const joinRequestLog = rendererLogger('contacts/group-join-requests')


// @@@2088 分段切换器收敛到 app 既有 tab 语言(下划线指示,--primary / --text-secondary / --border-subtle token),
// 不再自成一套 pill 胶囊形状。
// border-color 只在 active/inactive 各给一次(base 不带)——同元素上两个 border-color utility 会被 Tailwind
// 生成序裁决、className 顺序不作数(#2103 真机审:base 的 border-transparent 曾盖掉 active 的 accent 下划线)。
const requestTabsClass = 'nfp-reqtabs mx-3.5 mb-3'
const requestHeadClass = 'nfp-head window-drag-region flex shrink-0 items-center gap-[9px] px-4 pb-3 pt-4 text-[length:var(--font-title)] font-semibold [-webkit-app-region:no-drag]'
// @@@1944 该按钮只在移动端渲染（onBack-gated）且是页面唯一出口 → 按 #1787 触控规范:
// ≥44px 触控目标（size-11）+ .gg-pressable 按压反馈（hover 在触屏无效）；负 margin 保持头部视觉密度。
const requestBackButtonClass = 'nfp-back-btn gg-pressable -my-2.5 -ml-2.5 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-[var(--radius-control)] border-none bg-transparent p-0 text-[var(--text-primary)]'
const requestBodyClass = 'nfp-reqbody flex-1 overflow-y-auto px-3 py-0.5'
const requestRowClass = 'nfp-reqrow gg-row flex cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] px-1.5 py-[9px]'
const requestMetaClass = 'nfp-meta min-w-0 flex-1'
const requestNameClass = 'nfp-name overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium text-[var(--text-primary)]'
const requestSubClass = 'nfp-sub mt-px overflow-hidden text-ellipsis whitespace-nowrap text-xs text-[var(--text-secondary)]'
const requestActionsClass = 'nfp-reqacts flex shrink-0 gap-1.5'
const requestStatusClass = 'nfp-status shrink-0 text-[length:var(--font-body)] text-[var(--text-tertiary)]'
const requestButtonBaseClass = 'rounded-[var(--radius-control)] border-none px-[11px] py-[5px] font-[inherit] text-xs font-medium !transition-opacity !duration-[var(--dur-fast)] !ease-[var(--ease)]'
const requestButtonEnabledClass = 'cursor-pointer'
const requestButtonDisabledClass = 'cursor-default opacity-60'
const requestOkClass = 'nfp-btn-ok bg-[var(--text-primary)] text-[var(--bg-primary)] enabled:hover:opacity-[0.88]'
const requestNoClass = "nfp-btn-no bg-[var(--bg-elevated)] text-[var(--text-secondary)] enabled:hover:bg-[var(--hover)] [[data-theme='light']_&]:bg-[var(--muted)]"
const requestEmptyClass = 'nfp-req-empty !py-[54px] text-center text-[length:var(--font-body)] text-[var(--text-secondary)]'
// @@@1944 tab 内待处理计数小圆标（bucket 级；入口行角标只有总数）

function requestActionButtonClass(kind: 'ok' | 'no', disabled: boolean): string {
  return cn(
    requestButtonBaseClass,
    disabled ? requestButtonDisabledClass : requestButtonEnabledClass,
    kind === 'ok' ? requestOkClass : requestNoClass,
  )
}

// ── Shared inline styles ──────────────────────────────────────────────────────

// 与请求行(px 6)同一条左边线。
const styleSectionLabel: CSSProperties = { padding: '12px 6px 4px', fontSize: 'var(--font-caption)', fontWeight: 600, color: 'var(--text-tertiary)' }
const styleRowError: CSSProperties = { padding: '0 6px 8px', fontSize: 'var(--font-caption)', color: 'var(--danger)' }
const stylePlaceholderAvatar: CSSProperties = { width: 34, height: 34, borderRadius: 'var(--radius-circle)', background: 'var(--bg-elevated)', flexShrink: 0 }
const openOnKey = (open: () => void) => (event: KeyboardEvent<HTMLDivElement>) => {
  if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open() }
}

// ── Request row (shared) ──────────────────────────────────────────────────────

// @@@6418 好友申请与入群申请是同一种表达:头像 · 谁 · 一行说明 · 行尾。行的几何与按钮只此一份,
// 两种请求各自只决定「显示什么」和「点了做什么」。行尾:等我处理的是同意 / 拒绝,其余是灰字状态;点行看详情。
function RequestRow({
  avatar,
  name,
  sub,
  status,
  onOpen,
  loading,
  onAccept,
  onReject,
  acceptLabel,
  rejectLabel,
  acceptData,
  rowData,
}: {
  avatar: ReactNode
  name: ReactNode
  sub: ReactNode
  status: string | null
  onOpen: () => void
  loading: boolean
  onAccept: () => void
  onReject: () => void
  acceptLabel: string
  rejectLabel: string
  acceptData?: Record<string, string | undefined>
  rowData?: Record<string, string | undefined>
}) {
  return (
    <div className={requestRowClass} role="button" tabIndex={0} onClick={onOpen} onKeyDown={openOnKey(onOpen)} {...rowData}>
      {avatar}
      <div className={requestMetaClass}>
        <div className={requestNameClass}>{name}</div>
        <div className={requestSubClass}>{sub}</div>
      </div>
      {status ? <div className={requestStatusClass}>{status}</div> : <div className={requestActionsClass} onClick={(event) => event.stopPropagation()}>
        <button
          className={requestActionButtonClass('ok', loading)}
          {...acceptData}
          onClick={onAccept}
          disabled={loading}
        >
          {acceptLabel}
        </button>
        <button
          className={requestActionButtonClass('no', loading)}
          onClick={onReject}
          disabled={loading}
        >
          {rejectLabel}
        </button>
      </div>}
    </div>
  )
}

// 详情底部:等我处理的是同一对操作(先收起详情,结果落在那一行上),其余是同一句状态。
function DetailFooter({ status, loading, onAccept, onReject, acceptLabel, rejectLabel }: {
  status: string | null
  loading: boolean
  onAccept: () => void
  onReject: () => void
  acceptLabel: string
  rejectLabel: string
}) {
  if (status) return <span data-testid="request-detail-status">{status}</span>
  return (
    <>
      <Button variant="secondary" size="sm" disabled={loading} onClick={onReject}>{rejectLabel}</Button>
      <Button variant="primary" size="sm" disabled={loading} onClick={onAccept}>{acceptLabel}</Button>
    </>
  )
}

// ── Friend / Agent request item ───────────────────────────────────────────────

// 收到的与我发出的同一种行:收到的显示对方与附言(无附言用默认说明),我发出的显示对方与「我:附言」。
function FriendRequestItem({
  entry,
  onAccept,
  onReject,
}: {
  entry: FriendRequestEntry
  onAccept: () => Promise<void>
  onReject: () => Promise<void>
}) {
  const { t } = useTranslation('contacts')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const { request: req, direction } = entry
  const peer = direction === 'received' ? req.sender : req.receiver
  const statusKey = friendRequestStatusKey(entry)
  const status = statusKey ? t(statusKey) : null

  const run = (action: () => Promise<void>) => () => {
    setOpen(false)
    setLoading(true)
    void action().finally(() => setLoading(false))
  }

  // "申请添加 Agent：<name>" for agent receiver, "Agent 加入请求" for agent sender,
  // "想加你为联系人" for plain human↔human requests (@@@1944 mirrors the tab bucketing below).
  const context = direction === 'sent'
    ? t('friendRequests.sentByMe')
    : req.receiver?.type === 'agent'
      ? t('friendRequests.addAgent', { name: req.receiver.display_name })
      : req.sender?.type === 'agent'
        ? t('friendRequests.agentJoin')
        : t('friendRequests.wantsContact')
  // @@@1505 有附言显附言，否则默认文案。用 ?.trim()|| 与 ContactsPanel 口径一致（空白串也回落）。
  const note = req.message?.trim() || null

  return (
    <>
      <RequestRow
        avatar={peer ? (
          <Avatar name={peer.display_name} avatarUrl={peer.avatar} seed={peer.id} size="md" isAgent={peer.type === 'agent'} />
        ) : (
          <div style={stylePlaceholderAvatar} />
        )}
        name={resolveOrLoud(peer?.display_name, `friend-request ${direction} peer ${req.id}`)}
        sub={note ? (direction === 'sent' ? t('friendRequests.myNote', { message: note }) : note) : context}
        status={status}
        onOpen={() => setOpen(true)}
        loading={loading}
        onAccept={run(onAccept)}
        onReject={run(onReject)}
        acceptLabel={t('friendRequests.accept')}
        rejectLabel={t('friendRequests.ignore')}
        acceptData={{
          'data-testid': AUTOMATION_TEST_IDS.contactsPendingRequestAcceptButton,
          'data-friend-request-id': req.id,
          'data-friend-request-receiver-id': req.receiver_id,
          'data-friend-request-receiver-type': req.receiver?.type ?? 'human',
        }}
        rowData={{ 'data-request-direction': direction, 'data-request-status': req.status }}
      />
      {open && peer ? (
        <RequestDetailSheet
          peer={peer}
          context={context}
          message={note}
          onClose={() => setOpen(false)}
          footer={<DetailFooter status={status} loading={loading} onAccept={run(onAccept)} onReject={run(onReject)} acceptLabel={t('friendRequests.accept')} rejectLabel={t('friendRequests.ignore')} />}
        />
      ) : null}
    </>
  )
}

// ── Group join request item ───────────────────────────────────────────────────

// @@@6418 我管理的群收到的入群申请(#858)。「谁想进哪个群」写在说明行里;有附言时附言跟在后面。
// 同意/拒绝走 decide_group_join —— 库里会按当下事实重判(人数上限、发起人是否还在群里),
// 被拒的原因已由 chatService 翻成产品文案(groupJoinError),这里原样展示,其余失败给通用文案。
function GroupJoinRequestItem({ request, onDecided }: { request: ManagedGroupJoinRequest; onDecided: () => Promise<void> }) {
  const { t } = useTranslation('contacts')
  const { identitiesById } = useChatStore('identitiesById')
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requester = identitiesById[request.requester_user_id]
  const requestedBy = request.requested_by_user_id ? identitiesById[request.requested_by_user_id] : undefined
  const groupName = resolveOrLoud(request.group.name, `join request group ${request.group.id}`)
  const joinLine = request.requester_type === 'agent' && request.requested_by_user_id
    ? t('groupJoinRequests.agentRequestedBy', { owner: resolveOrLoud(requestedBy?.display_name, `agent join requested by ${request.requested_by_user_id}`), group: groupName })
    : t('groupJoinRequests.wantsToJoin', { group: groupName })
  const note = request.message?.trim() || null
  const status = request.status === 'pending' ? null : t(request.status === 'accepted' ? 'groupJoinRequests.statusAccepted' : 'groupJoinRequests.statusRejected')

  const decide = async (accept: boolean) => {
    if (loading) return
    setOpen(false)
    setLoading(true)
    setError(null)
    try {
      await chatService.decideGroupJoin(request.id, accept)
      await onDecided()
    } catch (cause) {
      joinRequestLog.error({ requestId: request.id, chatId: request.group.id, error: String(cause) }, 'group join decision failed')
      setError(messageForUser(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div data-testid="group-join-request" data-join-request-id={request.id}>
      <RequestRow
        avatar={<Avatar name={requester?.display_name ?? ''} avatarUrl={requester?.avatar ?? null} seed={request.requester_user_id} size="md" isAgent={request.requester_type === 'agent'} />}
        name={resolveOrLoud(requester?.display_name, `group join requester ${request.requester_user_id}`)}
        sub={note ? `${joinLine} · ${note}` : joinLine}
        status={status}
        onOpen={() => setOpen(true)}
        loading={loading}
        onAccept={() => { void decide(true) }}
        onReject={() => { void decide(false) }}
        acceptLabel={t('friendRequests.accept')}
        rejectLabel={t('groupJoinRequests.reject')}
        acceptData={{ 'data-testid': 'group-join-request-accept' }}
        rowData={{ 'data-request-status': request.status }}
      />
      {error ? <div role="alert" style={styleRowError}>{error}</div> : null}
      {open && requester ? (
        <RequestDetailSheet
          peer={requester}
          context={joinLine}
          message={note}
          onClose={() => setOpen(false)}
          footer={<DetailFooter status={status} loading={loading} onAccept={() => { void decide(true) }} onReject={() => { void decide(false) }} acceptLabel={t('friendRequests.accept')} rejectLabel={t('groupJoinRequests.reject')} />}
        />
      ) : null}
    </div>
  )
}

// ── Back chevron icon ─────────────────────────────────────────────────────────

function BackChevron() {
  // prototype: <svg width="17" height="17" viewBox="0 0 24 24">...chevron-left</svg>
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
        d="m15 5-6 7 6 7"
      />
    </svg>
  )
}

// ── NewFriendsPanel (exported) ────────────────────────────────────────────────

// @@@add-friend-unify NewFriendsPanel 现在是纯「新的请求」面板——只看/处理收发的好友申请。
// 「搜索用户 → 发申请」已抽到 AddFriendSearch（由 ContactsPanel 的「添加联系人」路由复用），
// 两个意图各自一条链路：加号图标 → 搜索加人；此面板 → 请求收件箱。不再靠「搜索框是否有字」在同一
// 面板里切两种用途（那正是「点添加联系人却落到请求列表」的根因）。
// @@@1944 onBack 是移动 pane 流的 affordance：传了才渲染「返回」chevron 且真返回；
// 桌面 master-detail 常驻双栏不传 → 不渲染（控件要么真生效要么不渲染）。
const REQ_PANEL_F = 'gg-req-panel-friends'
const REQ_PANEL_A = 'gg-req-panel-agents'

export function NewFriendsPanel({ onOpenGroupChat, onBack }: { onOpenGroupChat?: (group: ContactGroupChat) => void; onBack?: () => void }) {
  const { t } = useTranslation('contacts')
  useBackLayer(onBack) // 手机整页:安卓返回键 = 左上返回
  const {
    friendRequests,
    groupInvitations,
    groupJoinRequests,
    groupJoinRequestsError,
    refreshGroupJoinRequests,
    requestsStatus,
    requestsError,
    refreshRequests,
    acceptRequest,
    rejectRequest,
  } = useContactsStore()
  const { refreshChats } = useChatStore('refreshChats')

  // Tab state: 'f' = 好友 (Friends), 'a' = Agent — mirrors prototype #reqtabs data-reqtab values
  const [activeTab, setActiveTab] = useState<'f' | 'a' | 'g'>('f')
  // @@@6418 入群申请没有实时推送(库里没有对应的 revision 事件):打开「新的请求」时补读一次,
  // 否则管理员得等下一次别的刷新才看得到新申请。
  useEffect(() => { void refreshGroupJoinRequests() }, [refreshGroupJoinRequests])
  const groupPendingCount = [...groupInvitations, ...groupJoinRequests].filter((request) => request.status === 'pending').length
  const showJoinSection = groupJoinRequests.length > 0 || Boolean(groupJoinRequestsError)

  // Split requests into human-friend vs agent tabs. @@@1944 a request is "Agent" when
  // EITHER side is an agent: receiver-agent = someone asking to add your agent, sender-agent =
  // an agent asking to join. If both sides are absent/human (data gap included), it falls into
  // the "好友" bucket.
  const involvesAgent = ({ request }: FriendRequestEntry) =>
    request.receiver?.type === 'agent' || request.sender?.type === 'agent'
  const friendEntries = friendRequests.filter((entry) => !involvesAgent(entry))
  const agentEntries = friendRequests.filter(involvesAgent)
  const friendPendingCount = friendEntries.filter(awaitsMe).length
  const agentPendingCount = agentEntries.filter(awaitsMe).length

  // SegmentedTabs 的键盘处理依赖 items 的身份；行内字面量每次渲染都是新对象，
  // 那个 useCallback 就等于没写。只有待处理数量变了才需要新身份。
  const tabItems = useMemo(() => [
    { value: 'f' as const, label: t('friendRequests.friendsTab'), badge: friendPendingCount, panelId: REQ_PANEL_F },
    { value: 'a' as const, label: t('friendRequests.agentTab'), badge: agentPendingCount, panelId: REQ_PANEL_A },
    { value: 'g' as const, label: t('friendRequests.groupTab'), badge: groupPendingCount, panelId: 'gg-req-panel-groups' },
  ], [friendPendingCount, agentPendingCount, groupPendingCount, t])

  // 同意别人加我的 Agent 会建一个「主人 + Agent + 对方」小群,直接带过去;真人好友那一行就地变成「已添加」。
  const acceptFriendRequest = async (requestId: string) => {
    const result = await acceptRequest(requestId)
    if (result.kind !== 'group' || !result.chatId) return
    if (result.member_count == null) throw new Error('Accepted request returned chatId without member count')
    onOpenGroupChat?.({
      id: result.chatId,
      kind: result.kind,
      name: resolveOrLoud(result.name, `accepted group request ${result.chatId}`),
      avatar_url: null,
      member_count: result.member_count,
      is_muted: false,
    })
  }
  const renderFriendEntries = (entries: FriendRequestEntry[], empty: string) => entries.length === 0
    ? <div className={requestEmptyClass}>{empty}</div>
    : entries.map((entry) => (
      <FriendRequestItem
        key={entry.request.id}
        entry={entry}
        onAccept={() => acceptFriendRequest(entry.request.id)}
        onReject={() => rejectRequest(entry.request.id)}
      />
    ))

  return (
    <div
      style={{
        flex: 1,
        height: '100%',
        background: 'var(--bg-primary)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header — prototype .reqview-head (lines 789, 236–237) */}
      <div className={requestHeadClass}>
        {/* 返回 chevron — prototype #req-back; mobile-only (@@@1944) */}
        {onBack ? (
          <button className={requestBackButtonClass} aria-label={t('common.back')} onClick={onBack}>
            <BackChevron />
          </button>
        ) : null}
        {t('friendRequests.title')}
      </div>

      {/* Segmented tabs — prototype .avseg.reqtabs (line 790). @@@1944 每个 tab 带自己桶的
          待处理计数：入口角标只给总数，落在非默认 tab 的请求（如发给你 Agent 的申请）必须在
          这里可发现，否则「角标 1 + 默认 tab 空态」= 幽灵请求。 */}
      {/* @@@2088 分段切换器收敛到共享 <SegmentedTabs>：原来这里是两个裸 <button>，
          Tab 到得了，但没有 role=tab / aria-selected，读屏听不出「这是一组标签、当前第几个」，
          也不接 ←/→。全 app 四处手写标签，这是其一。选中态统一使用品牌 --primary，且不再叠字重——
          calm-ui：一条下划线已经把状态说清楚了。 */}
      <div className={requestTabsClass}>
        <SegmentedTabs
          items={tabItems}
          value={activeTab}
          onChange={setActiveTab}
          variant="underline"
          ariaLabel={t('friendRequests.sectionsLabel')}
        />
      </div>

      {requestsStatus === 'error' && (
        <div role="alert" className="mx-4 mb-3 text-sm text-[var(--danger)]">
          {messageForUser(new Error(requestsError ?? ''))}
          <Button variant="ghost" size="sm" className="ml-2 underline" onClick={() => void refreshRequests()}>{t('common.retry')}</Button>
        </div>
      )}
      {/* Content — tab panes (prototype .reqbody[data-reqpane], lines 791–797).
          Both panes stay in the DOM (inactive hidden via display:none) so tests can find
          buttons in either pane. */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div id="gg-req-panel-groups" role="tabpanel" tabIndex={-1} hidden={activeTab !== 'g'}>
          {/* @@@6418 群页签 = 我管理的群收到的入群申请 + 别人邀请我入群。两类都有时各带小标题;
              空的那类不占位(❌ 在入群申请下面再挂一个「群邀请 · 暂无」)。群邀请还在加载/读失败时照旧交给
              GroupInvitationsPanel 出加载与失败态;两类都确实为空时给一句合并的空态。 */}
          {showJoinSection ? (
            <div className={requestBodyClass} data-testid="group-join-requests">
              <div style={styleSectionLabel}>{t('groupJoinRequests.title')}</div>
              {groupJoinRequestsError ? (
                <div role="alert" style={styleRowError}>
                  {messageForUser(new Error(groupJoinRequestsError))}
                  <Button variant="ghost" size="sm" className="ml-2 underline" onClick={() => void refreshGroupJoinRequests()}>{t('common.retry')}</Button>
                </div>
              ) : null}
              {groupJoinRequests.map((request) => (
                <GroupJoinRequestItem
                  key={request.id}
                  request={request}
                  onDecided={async () => { await Promise.all([refreshGroupJoinRequests(), refreshChats()]) }}
                />
              ))}
              {groupInvitations.length > 0 ? <div style={styleSectionLabel}>{t('groupInvitations.title')}</div> : null}
            </div>
          ) : null}
          {groupInvitations.length > 0 || requestsStatus !== 'ready'
            ? <GroupInvitationsPanel />
            : showJoinSection ? null : <div className={requestEmptyClass}>{t('friendRequests.emptyGroups')}</div>}
        </div>
        {/* 好友 pane (data-reqpane="f") */}
        <div className={requestBodyClass} id={REQ_PANEL_F} role="tabpanel" tabIndex={-1} style={{ display: activeTab === 'f' ? undefined : 'none' }}>
          {renderFriendEntries(friendEntries, t('friendRequests.emptyFriends'))}
        </div>

        {/* Agent pane (data-reqpane="a") — prototype line 795–797 */}
        <div className={requestBodyClass} id={REQ_PANEL_A} role="tabpanel" tabIndex={-1} style={{ display: activeTab === 'a' ? undefined : 'none' }}>
          {renderFriendEntries(agentEntries, t('friendRequests.emptyAgents'))}
        </div>
      </div>
    </div>
  )
}
