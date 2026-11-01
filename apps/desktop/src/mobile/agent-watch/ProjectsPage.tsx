import { observer } from 'mobx-react-lite'
import { nameTwinIds } from '@/session/renderer/features/projects/name-twins'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { isAgentHostDevice, isPhoneDevice } from '@gugu/core/cloud/devices'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { SectionLabel } from '@/components/ui/SectionLabel'
import { ChevronDown, ChevronRight, Plus } from '@/lib/icons'
import { useAssistantName } from '@/hooks/useAssistantHomeLabel'
import { useDevicesStore } from '@/store/devicesContext'
import { agentOfSession, deviceSessionsOf, directoryRows, useAgentNames, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'
import { usePhoneAssistantIdentity } from '../assistant/phoneAssistantIdentity'
import { AgentWatchNote, AgentWatchScreen } from './AgentWatchChrome'
import { OfflineNote } from './OfflineNote'
import { SessionActions, SessionRow } from './SessionsPage'
import { assistantGroupIds, locateSession, sessionSections, type SessionNode, type SessionSection } from './session-sections'
import { useMachineLabel } from './useMachineLabel'
import { directoryMachines, visibleMachines } from './machine-list'
import { DeviceDirectoryRetry } from './DeviceDirectoryRetry'
import { PhoneHostSetupEntry } from './PhoneHostSetupEntry'
import { phoneAgentAvailable } from '../local-agent/nativeAgent'
import './task-flow-catalog'

// 折叠与「展开显示」只是本机的阅读偏好。键是格(`机器|项目`)与父会话 id,全局唯一,所以一份就够。
const COLLAPSED_KEY = 'gugu.agent-watch.collapsed.projects'
const MORE_KEY = 'gugu.agent-watch.more.projects'

/** 读不到 / 抛了(隐私模式)就当全展开,❌ 不报错。 */
function readStoredSet(key: string): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function useStoredSet(key: string): [ReadonlySet<string>, (id: string) => void, (ids: readonly string[], present: boolean) => void] {
  const [value, setValue] = useState(() => readStoredSet(key))
  const update = useCallback((change: (next: Set<string>) => void): void => {
    setValue((current) => {
      const next = new Set(current)
      change(next)
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify([...next]))
      } catch {
        // 存不了就存不了,下次进来全展开。
      }
      return next
    })
  }, [key])
  const toggle = useCallback((id: string): void => update((next) => { if (!next.delete(id)) next.add(id) }), [update])
  const set = useCallback((ids: readonly string[], present: boolean): void => {
    update((next) => { for (const id of ids) { if (present) next.add(id); else next.delete(id) } })
  }, [update])
  return [value, toggle, set]
}

const ALL_OPEN = { has: () => true }

/**
 * 一台离线的机器页顶原来那一行,现在跟在它名下每个分区的页头后面(只一行,收起的分区不画)。收回着 / 正在起来的云端宿主
 * ❌ 说(owner 10-17:Agent 没有休息这回事;点开它上面的会话就在连它,那一页自己说「正在连接」)。
 */
function MachineNote({ device, error }: { device: Device; error?: string | null }): ReactNode {
  if (device.cloud_computer === 'asleep' || device.cloud_computer === 'waking') return null
  if (!device.is_online) return <OfflineNote device={device} />
  // 在线却此刻读不到(那台机器一时连不上):下面画的是它上报过的那份,照实说一句,❌ 红框(红框留给一行都拿不出来)。
  return error ? (
    <div className="gg-aw-offline" data-testid="agent-watch-unreachable">
      <div className="gg-aw-offline-line"><span className="gg-aw-offline-text">{error}</span></div>
    </div>
  ) : null
}

/**
 * 「项目」tab 的根页(#7199,owner 10-16):账号名下**所有机器**上的项目与会话,一页滚到底 ——
 * 与桌面侧栏同一种按项目的结构,机器是项目分区页头上的属性(「项目 · 机器」),不再是上一层。
 *
 * 个人助理的云端宿主不列(它的项目名 / 机器名都不出现),它派出的会话是一组、组名就是它;它自己那条也不列。
 * 机器离线时**不发 RPC**:离线机器的行读心跳摘要(deviceSessionsOf),打不开的行灰着,分区页头下说一句为什么。
 */
export const ProjectsPage = observer(function ProjectsPage({
  onOpenSession,
  onCreate,
  reveal,
  scrollMemo,
}: {
  /** 交出行所在的机器,❌ 当成别的。 */
  onOpenSession: (deviceId: string, session: SessionpageSessionSummary) => void
  /** 页头右上角的 +:去选在哪台机器上新建(建会话要在那台机器上起进程,选机器那一步照旧)。 */
  onCreate?: () => void
  /** 一条点不开的行被点名(gugu.showSession):展开它所在的分区、滚到它;不给 = 照常从头看。 */
  reveal?: { deviceId: string; sessionId: string } | { projectId: string }
  /** 滚动位置的存放处:进时间线再回来要还在原处,页面自己在返回时是重新挂的。 */
  scrollMemo: MutableRefObject<number>
}) {
  const { t } = useTranslation('main')
  const { t: tFlow } = useTranslation('mobileTaskFlow')
  const { devices: allDevices, phones, loading: devicesLoading, error: devicesError } = useDevicesStore()
  const devices = useMemo(() => [...new Map([...(phones ?? []), ...allDevices].map((device) => [device.device_id, device])).values()], [allDevices, phones])
  const live = useLiveDeviceSessions()
  const agentNames = useAgentNames()
  // #7199 个人助理不住项目区:它自己的会话不列,它派的归一组、标「由它发起」(桌面侧栏同一条)。
  const assistant = usePhoneAssistantIdentity()
  const assistantName = useAssistantName()
  const { label: machineLabel, isHome } = useMachineLabel()

  const machines = useMemo(() => directoryMachines(devices, isHome), [devices, isHome])
  // The empty state offers creation only where an agent can run; an action-only phone keeps its directory row but is not a target.
  const hostCount = useMemo(() => visibleMachines(devices, isHome).length, [devices, isHome])
  const homeIds = useMemo(() => new Set(devices.filter((device) => isHome(device)).map((device) => device.device_id)), [devices, isHome])
  const deviceOf = useMemo(() => new Map(devices.map((device) => [device.device_id, device])), [devices])
  const rows = useMemo(() => directoryRows(devices, live), [devices, live])
  const assistantId = assistant?.id ?? null
  const groupIds = useMemo(() => assistantGroupIds(rows, assistantId, homeIds), [rows, assistantId, homeIds])
  const sectionMachines = useMemo(
    () => machines.map((device) => ({ deviceId: device.device_id, projects: deviceSessionsOf(device, live).projects })),
    [machines, live],
  )
  const online = useCallback((deviceId: string) => {
    const device = deviceOf.get(deviceId)
    if (!device?.is_online) return false
    if (!isPhoneDevice(device)) return true
    const here = deviceSessionsOf(device, live)
    return isAgentHostDevice(device) && !here.cached && !here.error
  }, [deviceOf, live])

  /**
   * 折起来的分区(owner 2026-09-15:「项目也应该可以折叠」)与父会话。子会话默认展开:桌面在子会话出生时会把父会话点开,
   * 手机看不到出生那一刻,默认收起就会把一条在等你的子会话藏起来。
   */
  const [collapsed, toggleCollapsed, setCollapsed] = useStoredSet(COLLAPSED_KEY)
  /** 点了「展开显示」的分区(收起的闲置家族全露)。 */
  const [moreOpen, toggleMore, setMore] = useStoredSet(MORE_KEY)
  /** 正在看管理动作的那条会话(行尾「…」打开的抽屉);null = 关着。 */
  const [menuFor, setMenuFor] = useState<{ deviceId: string; session: SessionpageSessionSummary; anchor: Element } | null>(null)

  // Read during every observer render: React's useMemo cannot track MobX presence dependencies.
  const sections = sessionSections(sectionMachines, rows, { assistantId, homeIds }, { expanded: moreOpen, online })

  // ── 点名定位:展开它所在的分区与父会话,再滚到它 ───────────────────────
  const bodyRef = useRef<HTMLDivElement>(null)
  const located = useMemo(() => {
    if (!reveal) return null
    const all = sessionSections(sectionMachines, rows, { assistantId, homeIds }, { expanded: ALL_OPEN, online })
    if ('projectId' in reveal) { const section = all.find((item) => item.project?.id === reveal.projectId); return section ? { section, ancestors: [] } : null }
    return locateSession(all, reveal.sessionId)
  }, [reveal, sectionMachines, rows, assistantId, homeIds, online])
  const revealed = useRef<typeof reveal>(undefined)
  const [scrollTarget, setScrollTarget] = useState<{ attribute: string; id: string } | null>(null)
  useEffect(() => {
    if (!reveal || !located || revealed.current === reveal) return
    revealed.current = reveal
    setCollapsed([located.section.key, ...located.ancestors], false)
    // 它在被「展开显示」收起的家族里 ⇒ 把这一格点开。
    if ('projectId' in reveal || !locateSession(sections, reveal.sessionId)) setMore([located.section.key], true)
    setScrollTarget('projectId' in reveal ? { attribute: 'data-project-id', id: reveal.projectId } : { attribute: 'data-session-id', id: reveal.sessionId })
  }, [reveal, located, sections, setCollapsed, setMore])
  useEffect(() => {
    if (!scrollTarget) return
    const row = [...(bodyRef.current?.querySelectorAll(`[${scrollTarget.attribute}]`) ?? [])]
      .find((el) => el.getAttribute(scrollTarget.attribute) === scrollTarget.id)
    if (!row) return
    if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center' })
    setScrollTarget(null)
  }, [scrollTarget, sections, collapsed])

  // 进时间线再回来,页面是重新挂的:滚回离开时的位置(被点名定位的那一次不还原,它自己滚)。
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    if (!reveal) body.scrollTop = scrollMemo.current
    const remember = (): void => { scrollMemo.current = body.scrollTop }
    body.addEventListener('scroll', remember, { passive: true })
    return () => body.removeEventListener('scroll', remember)
  }, [scrollMemo, reveal])

  // ── 行与标记 ────────────────────────────────────────────────────────
  const projectName = (deviceId: string, projectId: string): string | undefined => {
    const device = deviceOf.get(deviceId)
    return device && !isHome(device) ? deviceSessionsOf(device, live).projects.find((project) => project.id === projectId && project.kind !== 'workspace')?.name : undefined
  }
  const launchedBy = translateSessionMessage('sidebar.launchedByAssistant', { name: assistant?.name ?? assistantName })
  const manyMachines = machines.length > 1
  const twins = nameTwinIds(sections.flatMap((section) => (section.project ? [{ id: section.key, name: section.project.name }] : [])))
  /**
   * 行上除 agent 名之外的标记。❌ 标机器(owner 10-28:会话列表不标机器,机器只在会话里说)。分区页头已经说了项目的格里
   * 不重复;置顶那格标自己的项目;挂在父会话下的行与父会话不在同一个项目里时标项目。
   */
  const tagsOf = (node: SessionNode, section: SessionSection, parent?: { deviceId: string; projectId: string }): string[] => {
    const { deviceId } = node.item
    const { projectId, conversationId } = node.item.session
    if (parent) {
      const project = parent.deviceId !== deviceId || projectId !== parent.projectId ? projectName(deviceId, projectId) : undefined
      return project ? [project] : []
    }
    const tags: string[] = []
    if (groupIds.has(conversationId)) tags.push(launchedBy)
    if (section.pinned) {
      const project = projectName(deviceId, projectId)
      if (project) tags.push(project)
    }
    return tags
  }
  const renderTree = (
    section: SessionSection,
    nodes: readonly SessionNode[],
    depth = 0,
    parent?: { deviceId: string; projectId: string },
  ): ReactNode[] =>
    nodes.flatMap((node) => {
      const open = !collapsed.has(node.item.id)
      const { deviceId } = node.item
      const { projectId } = node.item.session
      const rowDevice = deviceOf.get(deviceId)
      const phone = !!rowDevice && isPhoneDevice(rowDevice)
      const hostAvailable = online(deviceId)
      const cancellable = node.item.session.agentStatus === 'working' || node.item.session.agentStatus === 'needs_user'
      return [
        <SessionRow
          key={node.item.id}
          session={node.item.session}
          agentName={agentOfSession(node.item.session, agentNames)?.displayName}
          tags={tagsOf(node, section, parent)}
          depth={depth}
          childCount={node.children.length}
          childrenOpen={open}
          onToggleChildren={() => toggleCollapsed(node.item.id)}
          statusAvailable={phone ? hostAvailable : undefined}
          phoneHost={phone}
          onOpen={(session) => onOpenSession(deviceId, session)}
          onMenu={(phone ? hostAvailable && cancellable : rowDevice?.is_online) ? (session, anchor) => setMenuFor({ deviceId, session, anchor }) : undefined}
        />,
        ...(open ? renderTree(section, node.children, depth + 1, { deviceId, projectId }) : []),
      ]
    })

  // ── 空 / 载入 / 出错 ────────────────────────────────────────────────
  const listed = machines.map((device) => ({ device, here: deviceSessionsOf(device, live) }))
  // 读不到时下面照样有上报过的那份:❌ 每一轮重试都闪一下「正在读取」,❌ 压一块红(owner 09-08:红框留给「什么都没有、也读不出来」)。
  const refreshing = listed.some(({ device, here }) => device.is_online && here.loading && !here.error)
  const failures = listed.filter(({ device, here }) => device.is_online && here.error && here.sessions.length === 0)
  const errorOf = new Map(listed.map(({ device, here }) => [device.device_id, here.error]))
  const nothingYet = sections.length === 0
  const waitingForMachines = devicesLoading && machines.length === 0
  // 助理那一组的页头下说宿主真的离线 —— 只在这一组里确有住在它上面的会话时说。收回着 / 正在起来的云端宿主 ❌ 说(MachineNote)。
  const homeDevice = devices.find((device) => isHome(device) && device.cloud_computer !== 'asleep' && device.cloud_computer !== 'waking' && !device.is_online)
  const onHome = (nodes: readonly SessionNode[]): boolean =>
    nodes.some((node) => homeIds.has(node.item.deviceId) || onHome(node.children))

  return (
    <AgentWatchScreen
      title={t('agentWatch.projects.title')}
      testId="agent-watch-projects"
      bodyRef={bodyRef}
      actions={
        onCreate ? (
          <IconButton
            size="md"
            aria-label={t('shell.newAgent')}
            data-testid="agent-watch-create-session"
            onClick={onCreate}
          >
            <Plus />
          </IconButton>
        ) : undefined
      }
    >
      {/*
        * 手里已经有上次那份 ⇒ ❌ 不画红。owner 2026-09-08 定的标准:「不应该是先报一个红色的报错、等我刷新之后才显示出来」——
        * 屏幕上那份仍然是真的,只是没更新;红框该留给「什么都没有、也读不出来」。
        */}
      {devicesError && machines.length === 0 ? (
        <AgentWatchNote
          title={t('agentWatch.machines.loadFailed')}
          detail={devicesError}
          tone="danger"
          testId="agent-watch-machines-error"
        >
          <DeviceDirectoryRetry />
        </AgentWatchNote>
      ) : null}
      {failures.map(({ device, here }) => (
        <AgentWatchNote
          key={device.device_id}
          title={t('agentWatch.sessions.loadFailed')}
          detail={manyMachines ? `${machineLabel(device)}: ${here.error}` : here.error}
          tone="danger"
          testId="agent-watch-sessions-error"
        />
      ))}

      {/* 有东西可看(本地那份或上一次的)就❌ 再塞一块占位把列表往下顶(owner 2026-09-15 真机:「加载态造成位置偏移」)。
          改成零高度的浮标,不占版面;只有真的一行都没有时才用整块占位。 */}
      {refreshing && !nothingYet ? (
        <div className="gg-aw-refreshing" role="status" aria-live="polite" data-testid="agent-watch-projects-refreshing">
          <span>{t('agentWatch.projects.loading')}</span>
        </div>
      ) : null}
      {nothingYet && (waitingForMachines || refreshing) ? (
        <div className="gg-aw-placeholder">
          {waitingForMachines ? t('agentWatch.machines.loading') : t('agentWatch.projects.loading')}
        </div>
      ) : null}
      {nothingYet && !waitingForMachines && !refreshing && !devicesError && failures.length === 0 ? (
        <div className="gg-aw-placeholder" data-testid="agent-watch-projects-empty">
          <div>{t('agentWatch.projects.empty')}</div>
          {hostCount === 0 && <div>{phoneAgentAvailable() ? tFlow('noHost') : t('agentWatch.projects.noMachines')}</div>}
          {hostCount === 0 ? <PhoneHostSetupEntry /> : onCreate ? (
            <Button variant="secondary" size="lg" onClick={onCreate} data-testid="agent-watch-empty-create">{tFlow('createTask')}</Button>
          ) : null}
        </div>
      ) : null}

      {sections.map((section) => {
        const { key } = section
        // 同名的项目格(两台机器上各有一个「Repo」)带上路径区分,与桌面侧栏同一个判据;不同名不带。
        const twinPath = section.project && twins.has(key) ? section.project.path : null
        const isCollapsed = collapsed.has(key)
        const machine = section.deviceId ? deviceOf.get(section.deviceId) : undefined
        const heading = section.pinned
          ? t('agentWatch.sessions.pinned')
          : section.assistant
            ? assistant?.name ?? assistantName
            : section.project?.name ?? t('agentWatch.sessions.tasks')
        const noteDevice = section.assistant ? (onHome(section.roots) ? homeDevice : undefined) : machine
        return (
          <div
            key={key}
            className="gg-aw-list"
            data-testid={section.pinned ? 'agent-watch-pinned-section' : 'agent-watch-session-group'}
            data-project-id={section.project?.id}
            data-collapsed={isCollapsed ? 'true' : 'false'}
            data-assistant={section.assistant ? 'true' : undefined}
          >
            <SectionLabel
              interactive
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              data-testid="agent-watch-session-group-toggle"
              leading={isCollapsed ? <ChevronRight /> : <ChevronDown />}
              trailing={isCollapsed ? <span className="gg-aw-group-count">{section.count}</span> : null}
              onClick={() => toggleCollapsed(key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapsed(key) } }}
            >
              {heading}
              {twinPath ? <span className="gg-aw-group-path" title={twinPath}>{` ${twinPath}`}</span> : null}
            </SectionLabel>
            {!isCollapsed && noteDevice ? <MachineNote device={noteDevice} error={errorOf.get(noteDevice.device_id)} /> : null}
            {isCollapsed ? null : renderTree(section, section.roots)}
            {!isCollapsed && section.folded > 0 ? (
              <Button
                variant="ghost"
                size="option"
                className="gg-aw-more"
                aria-expanded={moreOpen.has(key)}
                data-testid="agent-watch-session-more"
                onClick={() => toggleMore(key)}
              >
                {moreOpen.has(key) ? t('agentWatch.sessions.showLess') : t('agentWatch.sessions.showMore', { count: section.folded })}
              </Button>
            ) : null}
          </div>
        )
      })}

      <SessionActions
          anchor={menuFor?.anchor ?? null}
          session={menuFor?.session ?? null}
          deviceId={menuFor?.deviceId ?? ''}
          phoneHost={!!menuFor && !!deviceOf.get(menuFor.deviceId) && isPhoneDevice(deviceOf.get(menuFor.deviceId)!)}
          onClose={() => setMenuFor(null)}
        />
    </AgentWatchScreen>
  )
})
