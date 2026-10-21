import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Users } from '@/lib/icons'
import type { DiscoverableGroup } from '@gugu/core/shared/types/contacts'
import { GroupInviteCard } from '../../components/groups/GroupInviteCard'
import { PaneEmptyState } from '../../components/ui/PaneEmptyState'
import { contactsService } from '../../lib/contacts'
import { useGroupInviteJoin } from '../../lib/groupInviteJoin'
import { DiscoverSearchField } from './DiscoverSearchField'
import { discoverPaneClass } from './paneClass'

/**
 * @@@1175 找群（公开群发现）——search_discoverable_groups，仅命中 is_discoverable=true，
 * 私有群不外泄。空 query = 列全部可发现群（广场默认列表）。
 */
export function DiscoverGroupsPane({ active, panelId }: { active: boolean, panelId?: string }) {
  const { t } = useTranslation('discover')
  // 搜索词归本 pane：搜的是公开群，和工作台搜团队/Agent 是两件事。
  const [searchQuery, setSearchQuery] = useState('')
  const [groups, setGroups] = useState<DiscoverableGroup[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joiningGroupId, setJoiningGroupId] = useState<string | null>(null)
  const { joining, join, reset: resetJoin } = useGroupInviteJoin()
  // @@@1874 加入失败限**本行**。groupsError 只表示「列表本身没加载出来」；把一次单群加入失败
  // 塞进它会清空整块列表，还会以「加载失败：…」前缀把加入失败说成加载失败。按 group id 存行级错。
  const [joinErrors, setJoinErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    setError(null)
    resetJoin()
    // 每次(重)搜清掉旧的行级加入失败，免得上次尝试的错跨搜索粘在重新出现的同一行上。
    setJoinErrors({})
    const timer = setTimeout(() => {
      contactsService.searchDiscoverableGroups(searchQuery.trim())
        .then((res) => { if (!cancelled) setGroups(res) })
        .catch((err: unknown) => {
          if (!cancelled) setError(err instanceof Error ? err.message : t('groups.loadFailedFallback'))
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, searchQuery, t, resetJoin])

  const handleJoin = useCallback(async (g: DiscoverableGroup) => {
    // @@@1874 链接关的群不发起加入（按钮本身也已置灰）：凭 token 的入群会被 RPC 拒，不给假的可点性。
    if (!g.join_token || g.is_member || g.invite_link_enabled === false || joining || joiningGroupId) return
    setJoiningGroupId(g.id)
    setJoinErrors((prev) => {
      if (prev[g.id] == null) return prev
      const next = { ...prev }
      delete next[g.id]
      return next
    })
    try {
      const res = await join(g, g.join_token)
      // 刷新该行状态（open→已加入 / approval→审核中）。不乐观骗：用 RPC 真返回。
      setGroups((prev) => prev.map((x) => x.id === g.id
        ? {
            ...x,
            is_member: res.status === 'joined',
            join_request_status: res.status === 'pending' ? 'pending' : x.join_request_status,
          }
        : x))
    } catch (err) {
      // 行级失败反馈：只标记本行，不动 error（列表其余内容原样保留）。用 RPC 真实 message，fail loud。
      setJoinErrors((prev) => ({
        ...prev,
        [g.id]: err instanceof Error ? err.message : t('groups.joinFailedFallback'),
      }))
    } finally {
      setJoiningGroupId(null)
    }
  }, [join, joining, joiningGroupId, t])

  const trimmed = searchQuery.trim()
  const settled = !loading && error == null

  return (
    <div className={discoverPaneClass(active)} id={panelId} role="tabpanel" tabIndex={-1} data-dpane="gp">
      <DiscoverSearchField
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t('groups.searchPlaceholder')}
        shortcutEnabled={active}
      />
      {loading && <div className="gg-spinner" role="status" aria-label={t('groups.searching')} />}
      {!loading && error != null && (
        <p className="gg-pane-status" role="alert">{t('groups.loadFailed', { error })}</p>
      )}

      {settled && groups.length === 0 && (
        <div className="gg-pane-empty-wrap">
          <PaneEmptyState
            icon={<Users size={26} color="var(--text-tertiary)" />}
            caption={trimmed !== '' ? t('groups.noResults', { query: trimmed }) : t('groups.empty')}
            hint={trimmed !== ''
              ? t('groups.searchHint')
              : t('groups.emptyHint')}
          />
        </div>
      )}

      {/* @@@1175 广场精选：浏览态（空搜）标注 featured 头；RPC 已按成员数降序=热门序，复用为精选列表。
          搜索态不显示精选头（呈现的是搜索结果）。平台级策展(is_featured 人工精选)留 follow-up。 */}
      {settled && groups.length > 0 && trimmed === '' && (
        <div className="gg-pane-head">
          <span className="gg-ph-title">{t('groups.featured')}</span>
          <span className="gg-ph-sub">{t('groups.featuredHint')}</span>
        </div>
      )}

      {settled && groups.map((g) => {
        const inviteLinkOff = g.invite_link_enabled === false
        const pending = g.join_request_status === 'pending'
        const joinable = Boolean(g.join_token) && !g.is_member && !pending && !inviteLinkOff && g.join_mode !== 'invite_only'
        const joiningThisGroup = joiningGroupId === g.id
        const joinError = joinErrors[g.id]

        return (
          <GroupInviteCard
            key={g.id}
            group={g}
            density="list"
            inviteLinkEnabled={!inviteLinkOff}
            joinTokenAvailable={Boolean(g.join_token)}
            joining={joiningThisGroup}
            joinError={joinError ?? null}
            onJoin={joinable ? () => { void handleJoin(g) } : undefined}
            inactiveAction="button"
            testId="discoverable-group-row"
          />
        )
      })}
    </div>
  )
}
