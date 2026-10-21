import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, UserPlus, X } from '@/lib/icons'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { isCloudAgentMarked } from '@gugu/core/shared/enums/agentTypeModels'
import { Avatar } from '../Avatar'
import { Sheet } from '../ui/Sheet'
import { chatService } from '../../lib/chat'
import { contactsService } from '../../lib/contacts'
import { AUTOMATION_TEST_IDS } from '../../lib/automationDom'
import { AGENT_SESSION_STARTED_EVENT } from '../../lib/agentConversationEvents'
import { SearchField } from '../ui/SearchField'
import { summarizeAgentJoinResults, type AgentJoinRequestStatus } from '../../lib/groupAgentJoin'
import { IconButton } from '../ui/IconButton'

type PickerTab = 'human' | 'agent'

export function MemberPickerModal({
  chatId,
  snapshot,
  currentUserId,
  canInviteHumans,
  onClose,
  onReload,
}: {
  chatId: string
  snapshot: GroupCollabSnapshot
  currentUserId: string | null
  canInviteHumans: boolean
  onClose: () => void
  onReload: () => Promise<void>
}) {
  const { t } = useTranslation('messaging')
  const [tab, setTab] = useState<PickerTab>(canInviteHumans ? 'human' : 'agent')
  // @@@2036 canInviteHumans 常在挂载后才异步解析(群设置加载),初始 tab 会先落 'agent'。
  // 只在 false→true 的解析瞬间跳一次 human 默认页;写成常驻规则(#1857 原版)会把手动切到
  // agent tab 的用户立刻掰回去——切 tab 即清 selectedIds,规则永真,tab 死锁。
  const userChoseTab = useRef(false)
  const selectTab = useCallback((next: PickerTab) => { userChoseTab.current = true; setTab(next) }, [])
  const prevCanInviteHumans = useRef(canInviteHumans)
  useEffect(() => {
    if (canInviteHumans && !prevCanInviteHumans.current && !userChoseTab.current) setTab('human')
    prevCanInviteHumans.current = canInviteHumans
  }, [canInviteHumans])
  const [query, setQuery] = useState('')
  const [contacts, setContacts] = useState<ContactUser[]>([])
  const [ownedAgents, setOwnedAgents] = useState<ContactUser[]>([])
  const [loading, setLoading] = useState(true)
  // @@@2089 多选批量加人:累积一个选择集(单 tab 内),而非单选替换。人类/Agent 走不同 add-member
  // 服务,故选择集按 tab 隔离(切 tab 清空)。
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // @@@2089 两个错误 state 分离(019f64ea §2 阻塞):`error` = 候选加载错误,加载 effect 每次跑都清;
  // `submitError` = 批量提交结果(部分失败说明),只由提交路径 + 用户主动交互(切 tab)清 —— 否则
  // onReload 触发的候选重载 setError(null) 会秒清刚设的部分失败提示,失败反馈闪一下就没(违 fail-loud)。
  const [error, setError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  // 「Agent 加入需审批」:我替自己的 agent 发起过的请求,在候选行上显示「等待审批 / 被拒绝」。
  const [agentRequests, setAgentRequests] = useState<Map<string, AgentJoinRequestStatus>>(new Map())
  const [notice, setNotice] = useState<string | null>(null)
  const reloadAgentRequests = useCallback(async () => {
    setAgentRequests(await chatService.listMyAgentJoinRequests(chatId))
  }, [chatId])
  useEffect(() => {
    reloadAgentRequests().catch((err: unknown) => setError(String((err as Error)?.message ?? err)))
  }, [reloadAgentRequests])

  // @@@picker-current-membership - exclude users already in the group from both tabs.
  const inGroup = useMemo(() => new Set([
    ...snapshot.humans.map((h) => h.id),
    ...snapshot.agents.map((a) => a.id),
  ]), [snapshot.agents, snapshot.humans])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      if (!currentUserId) { setLoading(false); return }
      setLoading(true)
      setError(null)
      try {
        const all = await contactsService.getContacts(currentUserId)
        if (cancelled) return
        const humans = canInviteHumans ? all.filter((c) => (c.type ?? 'human') === 'human' && !inGroup.has(c.id)) : []
        // @@@1761 云 agent 禁入群(止血):加成员选择器不出现云 agent(双标记判定,同建群选择器)
        const agents = all.filter((c) => c.type === 'agent' && !isCloudAgentMarked(c) && c.owner_user_id === currentUserId && !inGroup.has(c.id))
        setContacts(humans)
        setOwnedAgents(agents)
      } catch (err) {
        if (!cancelled) setError(String((err as Error)?.message ?? err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    const handleAgentCreated = () => load()
    window.addEventListener(AGENT_SESSION_STARTED_EVENT, handleAgentCreated)
    return () => {
      cancelled = true
      window.removeEventListener(AGENT_SESSION_STARTED_EVENT, handleAgentCreated)
    }
  }, [canInviteHumans, currentUserId, inGroup])

  useEffect(() => { setSelectedIds(new Set()); setSubmitError(null) }, [tab])
  useEffect(() => {
    if (!canInviteHumans && tab === 'human') setSelectedIds(new Set())
  }, [canInviteHumans, tab])

  const candidates = tab === 'human' ? contacts : ownedAgents
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return candidates
    return candidates.filter((c) => {
      const haystack = `${c.display_name} ${c.email ?? ''} ${c.gugu_number ?? ''}`.toLowerCase()
      return haystack.includes(keyword)
    })
  }, [candidates, query])

  const handleConfirm = useCallback(async () => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setBusy(true)
    setSubmitError(null)
    setNotice(null)
    try {
      if (tab === 'human' && !canInviteHumans) throw new Error(t('group.picker.humanPermissionError'))
      // @@@2089 复用既有单人 add-member 服务逐个加(无批量 RPC,别新开路径);allSettled 收集部分失败,
      // 成功的已落库、reload 后从候选剔除,失败的保留在选择集里让用户重试。
      const results = await Promise.allSettled(
        ids.map((id) => tab === 'human'
          ? chatService.inviteGroupHuman(chatId, id)
          : chatService.joinGroupAgent(chatId, id, 'member')),
      )
      await onReload()
      const failedIds = ids.filter((_, i) => results[i].status === 'rejected')
      const summary = summarizeAgentJoinResults(results)
      if (summary.pendingApproval > 0) {
        // 需审批的群:agent 没进群,是一条待审请求。留在弹窗里说清楚,并刷新行上的「等待审批」。
        setNotice(t('group.picker.pendingApproval', { count: summary.pendingApproval }))
        await reloadAgentRequests().catch(() => undefined)
      }
      if (failedIds.length === 0) {
        if (summary.pendingApproval === 0) onClose()
        else setSelectedIds(new Set())
      } else {
        setSelectedIds(new Set(failedIds))
        const firstReason = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined)?.reason
        const okCount = ids.length - failedIds.length
        const reason = String((firstReason as Error)?.message ?? firstReason)
        setSubmitError(okCount > 0
          ? t('group.picker.partialFailure', { succeeded: okCount, failed: failedIds.length, reason })
          : t('group.picker.allFailed', { failed: failedIds.length, reason }))
      }
    } catch (err) {
      setSubmitError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }, [canInviteHumans, chatId, onClose, onReload, reloadAgentRequests, selectedIds, t, tab])

  return (
    <Sheet onClose={onClose} desktopWidth="580px" desktopMaxHeight="calc(100vh - 48px)" ariaLabel={t('group.picker.title')}>
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 'var(--font-title)', fontWeight: 600, color: 'var(--text-primary)' }}>{t('group.picker.title')}</div>
          <IconButton size="sm" aria-label={t('common.close')} onClick={onClose} disabled={busy}>
            <X size={16} />
          </IconButton>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-subtle)' }}>
          <PickerTabButton testId={AUTOMATION_TEST_IDS.groupMembersPickerHumanTab} active={tab === 'human'} onClick={() => selectTab('human')}>{t('group.picker.inviteHumans', { count: contacts.length })}</PickerTabButton>
          <PickerTabButton testId={AUTOMATION_TEST_IDS.groupMembersPickerAgentTab} active={tab === 'agent'} onClick={() => selectTab('agent')}>{t('group.picker.addAgents', { count: ownedAgents.length })}</PickerTabButton>
        </div>

        {tab === 'human' && !canInviteHumans ? null : (
          <div style={{ padding: 12, borderBottom: '1px solid var(--border-subtle)' }}>
            <SearchField
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={tab === 'human' ? t('group.picker.searchContacts') : t('group.picker.searchAgents')}
              autoFocus
            />
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
          {!canInviteHumans && tab === 'human' ? (
            <div
              data-testid={AUTOMATION_TEST_IDS.groupMembersPickerHumanDenied}
              style={{
                padding: 24,
                textAlign: 'center',
                color: 'var(--text-tertiary)',
                fontSize: 'var(--font-body)',
                lineHeight: 1.6,
              }}
            >
              {t('group.picker.humanPermissionHint')}
            </div>
          ) : null}
          {loading && !(tab === 'human' && !canInviteHumans) && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-body)' }}>{t('common.loading')}</div>
          )}
          {!loading && !(tab === 'human' && !canInviteHumans) && filtered.length === 0 && (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-body)' }}>
              {tab === 'human'
                ? (contacts.length === 0 ? t('group.picker.noContacts') : t('group.picker.noContactResults'))
                : (ownedAgents.length === 0 ? t('group.picker.noAgents') : t('group.picker.noAgentResults'))}
            </div>
          )}
          {!loading && !(tab === 'human' && !canInviteHumans) && filtered.length > 0 && filtered.map((user) => {
            const active = selectedIds.has(user.id)
            return (
              <button
                key={user.id}
                type="button"
                aria-pressed={active}
                // @@@2089 多选:点行切换该成员在选择集里的存在(勾/取消勾),不再替换。
                onClick={() => setSelectedIds((prev) => {
                  const next = new Set(prev)
                  if (next.has(user.id)) next.delete(user.id)
                  else next.add(user.id)
                  return next
                })}
                style={{
                  width: '100%',
                  height: 48,
                  border: active ? '1px solid var(--primary)' : '1px solid transparent',
                  borderRadius: 'var(--radius-control)',
                  // @@@state-ladder-mix 同上:选中走 --selected,色相留给危险项。
                  background: active ? 'var(--selected)' : 'transparent',
                  color: 'var(--text-primary)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '0 10px',
                  cursor: 'pointer',
                  textAlign: 'left',
                  marginBottom: 4,
                }}
              >
                <Avatar name={user.display_name} avatarUrl={user.avatar} seed={user.id} size="sm" isAgent={user.type === 'agent'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-body)', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user.display_name}</div>
                  <div style={{ marginTop: 2, fontSize: 'var(--font-caption)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {user.type === 'agent' && agentRequests.get(user.id) === 'pending'
                      ? t('group.picker.agentRequestPending')
                      : user.type === 'agent' && agentRequests.get(user.id) === 'rejected'
                        ? t('group.picker.agentRequestRejected')
                        : user.email ?? (user.gugu_number == null ? t('group.picker.guguIdUnassigned') : t('group.picker.guguId', { number: user.gugu_number }))}
                  </div>
                </div>
                {active ? <CheckCircle2 size={16} color="var(--primary)" /> : null}
              </button>
            )
          })}
        </div>

        {/* @@@2089 submitError(部分失败说明)优先于 error(加载错误)显示,且不被候选重载清掉。 */}
        {(submitError ?? error) ? (
          <div style={{ padding: '6px 14px', fontSize: 'var(--font-caption)', color: 'var(--danger)' }}>{submitError ?? error}</div>
        ) : null}
        {notice ? (
          <div role="status" className="px-[14px] py-[6px] text-[length:var(--font-caption)] text-[var(--text-secondary)]">{notice}</div>
        ) : null}

        <div style={{ height: 56, borderTop: '1px solid var(--border-subtle)', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ minWidth: 0, color: 'var(--text-tertiary)', fontSize: 'var(--font-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedIds.size > 0 ? t('group.picker.selection', { count: selectedIds.size }) : t('group.picker.selectionHint')}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" onClick={onClose} disabled={busy} style={{ height: 32, minWidth: 60, padding: '0 12px', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-document)', background: 'var(--bg-primary)', color: 'var(--text-secondary)', fontSize: 'var(--font-body)', cursor: busy ? 'default' : 'pointer' }}>{t('common.cancel')}</button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy || selectedIds.size === 0}
              style={{
                height: 32,
                minWidth: 72,
                padding: '0 14px',
                border: 'none',
                borderRadius: 'var(--radius-document)',
                background: busy || selectedIds.size === 0 ? 'var(--bg-elevated)' : 'var(--primary)',
                color: busy || selectedIds.size === 0 ? 'var(--text-tertiary)' : 'var(--text-on-accent)',
                fontSize: 'var(--font-body)',
                fontWeight: 600,
                cursor: busy || selectedIds.size === 0 ? 'default' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <UserPlus size={13} />
              {busy ? t('group.picker.adding') : t('group.picker.add')}
            </button>
          </div>
        </div>
      </div>
    </Sheet>
  )
}

function PickerTabButton({
  testId,
  active,
  onClick,
  children,
}: {
  testId?: string
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        height: 40,
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--primary)' : 'transparent'}`,
        background: 'transparent',
        color: active ? 'var(--primary)' : 'var(--text-secondary)',
        fontSize: 'var(--font-body)',
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}
