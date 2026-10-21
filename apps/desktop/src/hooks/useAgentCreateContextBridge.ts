import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isLifecycleCancellation } from '../lib/authBoundedFetch'
import { rendererLogger } from '../lib/log'
import {
  readAgentCreateDefaults,
  rememberAgentCreateDevice,
  rememberAgentCreateProject,
} from '../lib/agentCreateDefaults'
import {
  CREATE_CONTEXT_BRIDGE_KEY,
  type CreateContextBirthGroup,
  type CreateContextBridge,
  type CreateContextDevice,
  type CreateContextSnapshot,
  type CreateContextBridgeWindow,
} from '../lib/agentCreateContextBridge'
import { useDevicesStore } from '../store/devicesContext'
import { isAssistantHome } from '../lib/assistantHome'
import {
  agentCreateDeviceBlockMessage,
  EMPTY_AGENT_CREATE_DEFAULTS,
  resolveAgentCreateDevice,
  resolveAgentCreateProject,
  type AgentCreateDefaults,
} from '@gugu/core/shared/ui/agentCreateDefaultsModels'
import { i18n } from '@/i18n'
import { deviceFsListDirectory } from '../lib/deviceFs'

// @@@per-user-create-defaults (#2525) — 把 per-user 的设备/项目默认值装到 window 桥上，供对话页创建
// 草稿里的会话页 composer 读。契约见 lib/agentCreateContextBridge.ts。

const createDefaultsLog = rendererLogger('agents/create-defaults')

const LOADING_SNAPSHOT: CreateContextSnapshot = {
  ready: false,
  devices: [],
  selectedDeviceId: null,
  selectedProjectId: null,
  projectsAvailable: false,
  blockMessage: null,
  birthGroup: null,
}

function snapshotKey(snapshot: CreateContextSnapshot): string {
  return JSON.stringify([
    snapshot.ready,
    snapshot.selectedDeviceId,
    snapshot.selectedProjectId,
    snapshot.projectsAvailable,
    snapshot.blockMessage,
    snapshot.birthGroup?.chatId ?? null,
    snapshot.birthGroup?.name ?? null,
    snapshot.devices.map((device) => `${device.id}|${device.label}|${device.isLocal}|${device.isOnline}|${device.platform ?? ''}|${device.lastSeenAt ?? ''}|${device.kind ?? ''}`),
  ])
}

export interface AgentCreateContextController {
  snapshot: CreateContextSnapshot
  rememberedProjectId: string | null
  selectDevice(deviceId: string): void
  selectProject(projectId: string | null): void
  reportAvailableProjects(projectIds: string[]): void
  clearBirthGroup(): void
}

export function useAgentCreateContextBridge(
  enabled: boolean,
  options: {
    allowRemoteDevice?: boolean
    /** 这次草稿生在哪个群里(群成员里点的「新建 Agent」);由壳持有,这里只放进快照。 */
    birthGroup?: CreateContextBirthGroup | null
    onClearBirthGroup?: () => void
  } = {},
): AgentCreateContextController {
  const allowRemoteDevice = options.allowRemoteDevice === true
  const birthGroup = options.birthGroup ?? null
  const onClearBirthGroupRef = useRef(options.onClearBirthGroup)
  onClearBirthGroupRef.current = options.onClearBirthGroup
  const { devices, error: devicesError, cloudComputer } = useDevicesStore()
  const homeId = cloudComputer?.snapshot?.deviceId ?? null
  const [defaults, setDefaults] = useState<AgentCreateDefaults | null>(null)
  // 读写失败一律 fail loud 冒到 composer 上并挡住提交：一个"记不住选择"的创建器如果照常放行，
  // 用户会在他以为选好的设备之外的地方建出 agent。
  const [ioError, setIoError] = useState<string | null>(null)
  const [availableProjects, setAvailableProjects] = useState<readonly string[]>([])

  // 每次草稿打开都重读：另一个客户端刚改过的选择要在这里看见（per-user 记忆的意义所在）。
  useEffect(() => {
    if (!enabled) {
      setDefaults(null)
      setIoError(null)
      setAvailableProjects([])
      return
    }
    let cancelled = false
    void readAgentCreateDefaults()
      .then((loaded) => {
        if (cancelled) return
        setDefaults(loaded)
        setIoError(null)
      })
      .catch((error: unknown) => {
        if (cancelled || isLifecycleCancellation(error)) return
        setDefaults(EMPTY_AGENT_CREATE_DEFAULTS)
        createDefaultsLog.error({ err: (error as Error)?.message ?? String(error) }, 'read agent create defaults failed')
        setIoError(i18n.t('create.defaults.readFailed', { ns: 'agents' }))
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  // @@@1759 同 CreateAgentModal 的 ownDevices：devices store 里可能有真的云设备行（`cloud:<uid>`，
  // ensure_cloud_device 建的）。它不是一台能承载会话的机器，不该出现在「在哪台机器上创建」里。
  // #7199 个人助理住的那台也不在:那台不接人开的任务,也不给人看(owner 10-15)。
  const hostDevices = useMemo(
    () => devices.filter((device) => !device.device_id.startsWith('cloud:') && !isAssistantHome(device, homeId)),
    [devices, homeId],
  )

  const snapshot = useMemo<CreateContextSnapshot>(() => {
    if (!enabled || !defaults) return LOADING_SNAPSHOT
    const visible: CreateContextDevice[] = hostDevices.map((device) => ({
      id: device.device_id,
      label: device.label,
      isLocal: device.is_current_device === true,
      isOnline: device.is_online,
      platform: device.platform,
      lastSeenAt: device.last_seen_at || null,
      kind: device.capabilities?.host_kind === 'server' ? 'server' : 'computer',
      ...(device.cloud_computer ? { cloudComputer: device.cloud_computer } : {}),
    }))
    const resolution = resolveAgentCreateDevice(defaults, hostDevices)
    const remoteDeviceReady = allowRemoteDevice && resolution.kind === 'blocked' && resolution.reason === 'remote'
    // @@@4287 `kind:'none'` 有两个来源,合并它们会让界面说假话:
    //   · hostDevices 为空          → 名下真的一台设备都没有,「本机尚未注册为咕咕设备」是实话;
    //   · hostDevices 非空但没有本机行 → 用户还没主动选过设备,而 ACP-only 装配的壳**永远**不会有
    //     本机行(web/Capacitor 没有 getLocalDeviceSelfSnapshot)。这在手机上是**首次创建的常态**,
    //     却照样报「没有可用设备」—— 而那台在线设备就列在上面的选择器里,这句话当场被自己证伪。
    // ❌ 不替他选一台(那是 #2525 明令禁止的静默回落),改成说真话并给出可操作的下一步。
    const needsExplicitDevice = allowRemoteDevice && resolution.kind === 'none' && hostDevices.length > 0
    const selectedDeviceId =
      resolution.kind === 'missing'
        ? null
        : resolution.kind === 'none'
          ? null
          : resolution.device.device_id
    const projectsAvailable = resolution.kind === 'ready' || remoteDeviceReady
    // 设备列表本身加载失败时不许装作"没有设备"——那会把一次故障读成一次事实。
    const deviceBlock = remoteDeviceReady
      ? null
      : needsExplicitDevice
        ? i18n.t('create.composer.deviceRequired', { ns: 'agents' })
        : agentCreateDeviceBlockMessage(resolution)
    const blockMessage =
      ioError ??
      (devicesError ? i18n.t('create.defaults.devicesFailed', { ns: 'agents' }) : null) ??
      deviceBlock
    return {
      ready: true,
      devices: visible,
      selectedDeviceId,
      selectedProjectId: projectsAvailable
        ? resolveAgentCreateProject(defaults, selectedDeviceId, availableProjects)
        : null,
      projectsAvailable,
      blockMessage,
      birthGroup,
    }
  }, [allowRemoteDevice, enabled, defaults, hostDevices, devicesError, ioError, availableProjects, birthGroup])

  const snapshotRef = useRef(snapshot)

  // #6264 远端机器上记住的目录只是个候选:先到那台机器上探一下它还在,再让它成为选择 ——
  // ❌ 不把一个已经不在的目录静默当默认。本机的项目由会话页自己上报(reportAvailableProjects)。
  const selectedRemote = snapshot.devices.find((device) => device.id === snapshot.selectedDeviceId && !device.isLocal && device.isOnline)
  const rememberedRemotePath = selectedRemote ? defaults?.projectByDevice[selectedRemote.id] ?? null : null
  useEffect(() => {
    if (!selectedRemote || !rememberedRemotePath || availableProjects.includes(rememberedRemotePath)) return
    const controller = new AbortController()
    deviceFsListDirectory(
      selectedRemote.id,
      { path: rememberedRemotePath, show_hidden: false },
      { signal: controller.signal, timeoutMs: 20_000, retryOnTimeout: false },
    ).then((response) => {
      if (controller.signal.aborted || !response.result || (response.error && response.error.code !== 'too_many_entries')) return
      setAvailableProjects([response.result.path])
    }).catch((reason: unknown) => {
      // 探不到 = 保持「未选择项目」;取消是正常收尾,不是故障。
      if (!controller.signal.aborted) createDefaultsLog.warn({ reason: String(reason) }, 'remembered remote project probe failed')
    })
    return () => controller.abort()
  }, [availableProjects, rememberedRemotePath, selectedRemote])
  const listenersRef = useRef(new Set<() => void>())
  const lastKeyRef = useRef<string | null>(null)

  useEffect(() => {
    snapshotRef.current = snapshot
    const key = snapshotKey(snapshot)
    if (key === lastKeyRef.current) return
    lastKeyRef.current = key
    for (const listener of listenersRef.current) listener()
  }, [snapshot])

  const persist = useCallback(async (write: () => Promise<AgentCreateDefaults>) => {
    try {
      setDefaults(await write())
      setIoError(null)
    } catch (error) {
      if (isLifecycleCancellation(error)) return
      createDefaultsLog.error({ err: (error as Error)?.message ?? String(error) }, 'save agent create defaults failed')
      setIoError(i18n.t('create.defaults.saveFailed', { ns: 'agents' }))
    }
  }, [])

  const selectDevice = useCallback(
    (deviceId: string) => {
      // 乐观先切，再落库：选择器要跟手；落库失败经 ioError 显式报出来，不悄悄回到旧值。
      setAvailableProjects([])
      setDefaults((current) => ({ ...(current ?? EMPTY_AGENT_CREATE_DEFAULTS), deviceId }))
      void persist(() => rememberAgentCreateDevice(deviceId))
    },
    [persist],
  )

  const selectProject = useCallback(
    (projectId: string | null) => {
      const deviceId = snapshotRef.current.selectedDeviceId
      if (!deviceId) return
      setDefaults((current) => {
        const base = current ?? EMPTY_AGENT_CREATE_DEFAULTS
        const projectByDevice = { ...base.projectByDevice }
        if (projectId) projectByDevice[deviceId] = projectId
        else delete projectByDevice[deviceId]
        return { ...base, projectByDevice }
      })
      void persist(() => rememberAgentCreateProject(deviceId, projectId))
    },
    [persist],
  )

  const reportAvailableProjects = useCallback((projectIds: string[]) => {
    setAvailableProjects((current) =>
      current.length === projectIds.length && current.every((id, index) => id === projectIds[index])
        ? current
        : projectIds,
    )
  }, [])

  const clearBirthGroup = useCallback(() => onClearBirthGroupRef.current?.(), [])

  useEffect(() => {
    const w = window as CreateContextBridgeWindow
    const bridge: CreateContextBridge = {
      getSnapshot: () => snapshotRef.current,
      subscribe: (listener) => {
        listenersRef.current.add(listener)
        return () => {
          listenersRef.current.delete(listener)
        }
      },
      selectDevice,
      selectProject,
      reportAvailableProjects,
      clearBirthGroup,
    }
    w[CREATE_CONTEXT_BRIDGE_KEY] = bridge
    return () => {
      if (w[CREATE_CONTEXT_BRIDGE_KEY] === bridge) delete w[CREATE_CONTEXT_BRIDGE_KEY]
    }
  }, [selectDevice, selectProject, reportAvailableProjects, clearBirthGroup])

  const rememberedProjectId = snapshot.selectedDeviceId && defaults
    ? defaults.projectByDevice[snapshot.selectedDeviceId] ?? null
    : null

  return useMemo(() => ({
    snapshot,
    rememberedProjectId,
    selectDevice,
    selectProject,
    reportAvailableProjects,
    clearBirthGroup,
  }), [clearBirthGroup, rememberedProjectId, reportAvailableProjects, selectDevice, selectProject, snapshot])
}
