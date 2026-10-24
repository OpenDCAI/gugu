import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { LayoutGrid, RefreshCw, Search } from '@/lib/icons'
import { Avatar } from '../../components/Avatar'
import { BuildAgentWizard } from '../../components/BuildAgentWizard'
import { IconButton } from '../../components/ui/IconButton'
import { PaneEmptyState } from '../../components/ui/PaneEmptyState'
import { useToast } from '../../components/toastContext'
import {
  cancelAgentTeamCreation,
  completeAgentTeamCreationHandoff,
  createAgentTeam,
  hydrateAgentTeamForReentry,
  type AgentTeamReentryState,
} from '../../lib/createAgentTeam'
import { loadPresetTeamCatalog } from '../../lib/presetTeamCatalog'
import { presetTeamToAgentTeam, type PresetTeam } from '../../lib/presetTeams'
import { discoverQueryClient } from '../../lib/discoverQueryClient'
import { readAllPublicAgentDisplayIdentities } from '../../lib/identityReadAdapter'
import { useChatStore } from '../../store/chatContext'
import { DiscoverSearchField } from './DiscoverSearchField'
import { PresetTeamCard } from './PresetTeamCard'
import { discoverPaneClass } from './paneClass'
import { messageForUser } from '../../lib/userFacingError'

export interface PublicAgent {
  id: string
  display_name: string
  avatar: string | null
  bio: string | null
  category: string | null
  owner_user_id: string | null
}

const PRESET_TEAMS_QUERY_KEY = ['discover', 'preset-teams'] as const

interface WorkbenchPaneProps {
  /** 非活动 pane 仍保持挂载(display:none)，切回来只在缓存过期时后台刷新。 */
  active: boolean
  panelId: string
  onSelectAgent?: (agent: PublicAgent) => void
  onNavigateToChat?: (chatId: string) => void
  /** 页头动作车道的挂载点（ExplorePage 的 PaneHeader 提供）。「刷新」钮 portal 到这里，
      只搬 DOM 位置，查询状态仍归本 pane；未传入时（如单测直接渲染本组件）退回原位内联渲染。 */
  headerActionsHost?: HTMLElement | null
}

/**
 * 工作台 pane —— 预设团队画廊 + 搜索命中的公开 Agent。
 *
 * 数据(预设团队目录、公开 agent 列表)与团队创建向导的状态都留在这里：只有本 pane 读它们，
 * 提到页面壳上只会让壳背一堆自己用不到的 state（how-to-write-component：所有权落到最低的消费者）。
 */
export function WorkbenchPane(props: WorkbenchPaneProps) {
  return (
    <QueryClientProvider client={discoverQueryClient}>
      <WorkbenchPaneContent {...props} />
    </QueryClientProvider>
  )
}

function WorkbenchPaneContent({
  active,
  panelId,
  onSelectAgent,
  onNavigateToChat,
  headerActionsHost,
}: WorkbenchPaneProps) {
  const { t } = useTranslation('discover')
  const { setDraft } = useChatStore('setDraft')
  const { toast } = useToast()

  const [agents, setAgents] = useState<PublicAgent[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentsError, setAgentsError] = useState<string | null>(null)

  const [presetForSheet, setPresetForSheet] = useState<AgentTeamReentryState | null>(null)

  // 搜索词归本 pane 所有：工作台搜团队/Agent，与「找群」是两件事，不共用一个输入。
  const [searchQuery, setSearchQuery] = useState('')

  const openPresetTeam = useCallback(async (preset: PresetTeam) => {
    try {
      const hydrated = await hydrateAgentTeamForReentry(presetTeamToAgentTeam(preset))
      setPresetForSheet(hydrated)
    } catch (error) {
      toast(messageForUser(error, t('workbench.cannotContinue')), 'error')
    }
  }, [toast, t])

  const presetTeamsQuery = useQuery({
    queryKey: PRESET_TEAMS_QUERY_KEY,
    queryFn: () => loadPresetTeamCatalog(),
    enabled: active,
  })
  const presetTeams = presetTeamsQuery.data ?? []
  const presetTeamsLoading = presetTeamsQuery.isPending
  const presetTeamsError = presetTeamsQuery.error instanceof Error
    ? presetTeamsQuery.error.message
    : presetTeamsQuery.error == null ? null : String(presetTeamsQuery.error)
  const presetTeamsRefreshing = presetTeamsQuery.isFetching && !presetTeamsLoading

  useEffect(() => {
    let cancelled = false
    setAgentsLoading(true)
    setAgentsError(null)

    void readAllPublicAgentDisplayIdentities()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) setAgentsError(error.message)
        else setAgents((data ?? []) as PublicAgent[])
        setAgentsLoading(false)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setAgents([])
        setAgentsError(error instanceof Error ? error.message : String(error))
        setAgentsLoading(false)
      })

    return () => { cancelled = true }
  }, [])

  const normalized = searchQuery.trim().toLowerCase()
  const hasQuery = normalized !== ''
  const filteredTeams = presetTeams.filter((team) => (
    !hasQuery || team.name.toLowerCase().includes(normalized)
  ))
  const filteredAgents = agents.filter((a) => {
    if (!hasQuery) return true
    return (
      a.display_name.toLowerCase().includes(normalized) ||
      (a.bio?.toLowerCase().includes(normalized) ?? false)
    )
  })

  // A stale snapshot remains usable while a background refresh is pending or has failed.
  const teamsSettled = !presetTeamsLoading && (presetTeamsError == null || presetTeams.length > 0)
  const agentsSettled = !agentsLoading && agentsError == null

  // 刷新钮：唯一实现走 IconButton。视觉落点在页头动作车道（见 headerActionsHost），
  // 但按钮本身（disabled/data-refreshing/onClick）仍在这里定义——它绑定的是本 pane 的查询状态。
  const refreshButton = (
    <IconButton
      aria-label={t('workbench.refreshTeams')}
      title={t('workbench.refreshTeams')}
      data-testid="preset-teams-refresh"
      disabled={!active || presetTeamsLoading || presetTeamsRefreshing}
      data-refreshing={presetTeamsRefreshing ? 'true' : undefined}
      onClick={() => { void presetTeamsQuery.refetch() }}
    >
      <RefreshCw aria-hidden="true" />
    </IconButton>
  )
  const nothingMatched = hasQuery && teamsSettled && agentsSettled
    && filteredTeams.length === 0 && filteredAgents.length === 0
  // 目录本身空(非搜索所致)：原来这里什么都不渲染 —— 一屏纯白，看不出是加载完了、
  // 出错了、还是真没有内容。空态必须自己开口说话。
  const catalogEmpty = !hasQuery && teamsSettled && presetTeams.length === 0

  return (
    <div
      className={discoverPaneClass(active)}
      id={panelId}
      role="tabpanel"
      tabIndex={-1}
      data-dpane="wb"
    >
      <DiscoverSearchField
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder={t('workbench.searchPlaceholder')}
        shortcutEnabled={active}
      />

      {active && headerActionsHost ? createPortal(refreshButton, headerActionsHost) : refreshButton}

      {/* 搜索时：命中的公开 Agent 排在预设团队之前。两段结果之间必须有分段头——
          否则一屏上是「N 行头像 + 若干张卡」，看不出哪些是 Agent、哪些是团队模板。
          分段头复用找群那边「广场精选」同一套 .gg-pane-head，全页一种分组语言。 */}
      {hasQuery && (agentsLoading || agentsError != null || filteredAgents.length > 0) && (
        <div style={{ marginBottom: 24 }}>
          {agentsSettled && filteredAgents.length > 0 && (
            <div className="gg-pane-head">
              <span className="gg-ph-title">{t('workbench.agents')}</span>
              <span className="gg-ph-sub">{t('workbench.publicAgentCount', { count: filteredAgents.length })}</span>
            </div>
          )}
          {agentsLoading && <div className="gg-spinner" role="status" aria-label={t('workbench.searchingAgents')} />}
          {!agentsLoading && agentsError != null && (
            <p className="gg-pane-status" role="alert">{t('workbench.loadFailed', { error: agentsError })}</p>
          )}
          {agentsSettled && filteredAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className="gg-agent-row"
              onClick={() => { onSelectAgent?.(agent) }}
            >
              <span className="gg-agent-av">
                {/* @@@1567 走统一 Avatar：只显示 agent 的 canonical avatar URL，不裸 img。
                    36→32：头像只有 --avatar-xs/sm/md/lg/xl 五档，36 不在梯子上（ui-ruler 审计
                    点名的「头像 32/38/40 三种」债务之一），对齐到最近的 --avatar-sm。 */}
                <Avatar avatarUrl={agent.avatar} seed={agent.id} name={agent.display_name} isAgent size={32} />
              </span>
              <span className="gg-agent-main">
                <span className="gg-agent-name">{agent.display_name}</span>
                {agent.bio != null && agent.bio !== '' && (
                  <span className="gg-agent-bio">{agent.bio}</span>
                )}
              </span>
              {/* 整行已是按钮，行尾不能再套一个 button（HTML 不允许按钮嵌按钮，读屏也会读出两个
                  可点目标）。这里退化成纯视觉标签，动作由整行承担。 */}
              <span className="gg-agent-open" aria-hidden="true">{t('workbench.openChat')}</span>
            </button>
          ))}
        </div>
      )}

      {presetTeamsLoading && (
        <div className="gg-spinner" role="status" aria-label={t('workbench.loadingTeams')} data-testid="preset-teams-loading" />
      )}
      {presetTeamsRefreshing && (
        <p className="gg-pane-status" role="status" data-testid="preset-teams-refreshing">
          {t('workbench.refreshingTeams')}
        </p>
      )}
      {!presetTeamsLoading && presetTeamsError != null && (
        <p
          className="gg-pane-status"
          role="alert"
          data-testid={presetTeams.length > 0 ? 'preset-teams-refresh-error' : 'preset-teams-error'}
        >
          {t(presetTeams.length > 0 ? 'workbench.teamsRefreshFailed' : 'workbench.teamsLoadFailed', { error: presetTeamsError })}
        </p>
      )}
      {teamsSettled && filteredTeams.length > 0 && hasQuery && (
        <div className="gg-pane-head">
          <span className="gg-ph-title">{t('workbench.teamTemplates')}</span>
          <span className="gg-ph-sub">{t('workbench.matchCount', { count: filteredTeams.length })}</span>
        </div>
      )}
      {teamsSettled && filteredTeams.length > 0 && (
        <div className="gg-teams">
          {filteredTeams.map((team, index) => (
            <PresetTeamCard
              key={team.id}
              team={team}
              priority={index === 0}
              className="gg-team-reveal"
              style={{ '--gg-team-reveal-index': index } as CSSProperties}
              onAction={() => { void openPresetTeam(team) }}
            />
          ))}
        </div>
      )}

      {catalogEmpty && (
        <div className="gg-pane-empty-wrap" data-testid="preset-teams-empty">
          <PaneEmptyState
            icon={<LayoutGrid size={26} color="var(--text-tertiary)" />}
            caption={t('workbench.emptyTitle')}
          />
        </div>
      )}

      {nothingMatched && (
        <div className="gg-pane-empty-wrap">
          <PaneEmptyState
            icon={<Search size={26} color="var(--text-tertiary)" />}
            caption={t('workbench.noResults', { query: searchQuery })}
            hint={t('workbench.noResultsHint')}
          />
        </div>
      )}

      {/* 预设团队 → gugu 现成的加团队向导：预览 → 创建(真 provision 成员 + 建群)→ 直接跳进新群 */}
      {presetForSheet && (
        <BuildAgentWizard
          initialTeam={presetForSheet.team}
          initialCancellationOperationId={presetForSheet.cancellationOperationId}
          onCreate={(team, onProgress) => createAgentTeam(team, { onProgress })}
          onCreated={(team, result) => completeAgentTeamCreationHandoff(team, result, {
            setDraft,
            close: () => { setPresetForSheet(null) },
            navigateToChat: (chatId) => { onNavigateToChat?.(chatId) },
          })}
          onCancel={cancelAgentTeamCreation}
          onClose={() => { setPresetForSheet(null) }}
        />
      )}
    </div>
  )
}
