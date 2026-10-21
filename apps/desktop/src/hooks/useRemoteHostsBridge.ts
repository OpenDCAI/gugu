import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { serverMachineNotices } from '@gugu/core/cloud/serverMachineHealth'
import type { SshSignInState } from '../lib/serverSshMachines'
import { useSshSignInStates } from './useSshSignInStates'
import {
  canOpenTunnels,
  currentSshMachineIds,
  currentTunnelState,
  requestSshServerUpgrade,
  signInSshMachine,
  subscribeSshMachineIds,
  subscribeTunnelState,
  wantTunnels,
} from '../lib/sshLinkChannel'
import { tunnelFacts, wantsTunnel, type TunnelState } from '../lib/tunnelMachines'
import { sshLinkFacts } from '../lib/sshLinkOnline'
import { useSshLinkProblems } from './useSshLinkProblems'
import { useDevicesStore } from '../store/devicesContext'
import { openRemoteSessionHostPipe } from '../lib/remoteSessionHost'
import { retryServerVersionMatch } from '../lib/serverVersionRetry'
import { chatService } from '../lib/chat'
import { CloudComputerWakeError } from '@gugu/core/cloud/cloudComputer'
import { wakeAndWaitOnline } from '../lib/cloudComputerStore'
import { isAssistantHome } from '../lib/assistantHome'
import { useAssistantName } from './useAssistantHomeLabel'
import {
  CloudComputerWakeFailed,
  installRemoteHostsBridge,
  type RemoteHostDevice,
  type RemoteHostsBridge,
} from '../session/shared/remote-hosts'

/**
 * #6264 把「名下别的机器」和「到那台机器会话页宿主的线」交给会话页(见 session/shared/remote-hosts.ts)。
 *
 * 本机不在其中(本机的项目会话页自己就有);云设备行(`cloud:<uid>`)不是一台能承载会话的机器,也不在。
 */
export function useRemoteHostsBridge(
  enabled: boolean,
  pickFolder: (deviceId: string, initialPath: string) => Promise<string | null>,
  openAddMachine?: () => void,
): void {
  const { devices, cloudComputer } = useDevicesStore()
  // #7199 个人助理住的那台:会话页里说到它,说的是它本人(名字由「助理」App 的壳认出来;还没认出 = 「个人助理」)。
  const homeId = cloudComputer?.snapshot?.deviceId ?? null
  const homeName = useAssistantName()
  const sshMachines = useSshMachineIds()
  // 离线的 SSH 机器:这个账号在那台机器上的登录还在不在(侧栏与会话里说「登录已失效」而不只是「离线」)。
  const sshAddress = useCallback((deviceId: string) => (sshMachines.has(deviceId) ? deviceId : null), [sshMachines])
  const signIns = useSshSignInStates(devices, sshAddress)
  const linkProblems = useSshLinkProblems()
  const tunnels = useTunnelState()
  // 远程隧道:在线、中转通着、这台电脑没有它的 SSH 映射的那几台,交给主进程经中转连过去(连通了就有终端 / 浏览器 / 端口)。
  useEffect(() => {
    wantTunnels(
      devices
        .filter((device) => wantsTunnel(device, sshMachines))
        .map((device) => ({ deviceId: device.device_id, label: device.label })),
    )
  }, [devices, sshMachines])
  const remote = useMemo<RemoteHostDevice[]>(
    () =>
      devices
        // 手机(#7199)不是 agent 的运行位置:设备列表在读的那一处已经分出去了(listDevices),这里不再画它。
        .filter((device) => !device.device_id.startsWith('cloud:') && device.is_current_device !== true && !isPhoneDevice(device))
        .map((device) => ({
          id: device.device_id,
          label: isAssistantHome(device, homeId) ? homeName : device.label,
          ...sshLinkFacts(sshMachines.has(device.device_id), linkProblems.get(device.device_id) ?? null, device.is_online),
          platform: device.platform,
          lastSeenAt: device.last_seen_at || null,
          sessionDigest: device.session_digest ?? null,
          directTerminal: sshMachines.has(device.device_id) || tunnels.ready.includes(device.device_id),
          ...(!sshMachines.has(device.device_id) && tunnels.ready.includes(device.device_id) ? { viaTunnel: true as const } : {}),
          ...tunnelFacts(device, sshMachines, tunnels, canOpenTunnels()),
          hostKind: device.capabilities?.host_kind === 'phone' ? undefined : device.capabilities?.host_kind,
          connectVia: device.capabilities?.connect_via,
          version: device.capabilities?.app_version ?? null,
          signInExpiredAt:
            sshMachines.has(device.device_id) && linkProblems.get(device.device_id) === 'notSignedIn'
              ? null
              : signInExpiredAt(signIns.get(device.device_id)),
          notices: serverMachineNotices(device.capabilities),
          ...(device.capabilities?.server_update ? { serverUpdate: device.capabilities.server_update.state } : {}),
          ...(device.cloud_computer ? { cloudComputer: device.cloud_computer } : {}),
          ...(isAssistantHome(device, homeId) ? { assistantHome: true as const } : {}),
        })),
    [devices, sshMachines, signIns, linkProblems, tunnels, homeId, homeName],
  )
  const remoteRef = useRef(remote)
  const pickFolderRef = useRef(pickFolder)
  pickFolderRef.current = pickFolder
  const openAddMachineRef = useRef(openAddMachine)
  openAddMachineRef.current = openAddMachine
  const listenersRef = useRef(new Set<() => void>())

  useEffect(() => {
    remoteRef.current = remote
    for (const listener of listenersRef.current) listener()
  }, [remote])

  // #6264 远程 SSH 的机器说「这台电脑上的咕咕太旧」(版本信号):这台桌面够得着它,请它换成匹配的那一版 ——
  // 同一账号没有更新的桌面在用它时就降到这一版;有的话什么也不换,照旧提示更新这台电脑(主进程判,带冷却)。
  const askedRef = useRef(new Set<string>())
  useEffect(() => {
    for (const device of remote) {
      if (!device.directTerminal || !device.notices?.some((notice) => notice.kind === 'desktop-too-old')) continue
      if (askedRef.current.has(device.id)) continue
      askedRef.current.add(device.id)
      void requestSshServerUpgrade(device.id, { desktopTooOld: true })
    }
  }, [remote])

  useEffect(() => {
    if (!enabled) return
    const bridge: RemoteHostsBridge = {
      listDevices: () => remoteRef.current,
      subscribeDevices: (listener) => {
        listenersRef.current.add(listener)
        return () => {
          listenersRef.current.delete(listener)
        }
      },
      // 那台机器的整套会话页宿主(一套工作台):线同上,在 deviceRpc.ts 里按机器挑。
      openSessionHost: (deviceId) => openRemoteSessionHostPipe(deviceId),
      pickFolder: (deviceId, initialPath) => pickFolderRef.current(deviceId, initialPath),
      openAddMachine: () => openAddMachineRef.current?.(),
      signInSsh: async (deviceId) => (await signInSshMachine(deviceId)).ok,
      // #7199 叫醒云电脑并等它在线:在不在线现读库(心跳翻了这一行才算醒好)。失败按约定的形状抛给会话页去说。
      wakeCloudComputer: async (deviceId) => {
        try {
          await wakeAndWaitOnline(deviceId, {
            isOnline: async (id) => (await chatService.listDevices()).some((row) => row.device_id === id && row.is_online),
          })
        } catch (error) {
          if (error instanceof CloudComputerWakeError) throw new CloudComputerWakeFailed(error.reason, error.code, error.message)
          throw new CloudComputerWakeFailed('failed', null, error instanceof Error ? error.message : String(error))
        }
      },
      // #7403 那台的咕咕太旧、不认这一问:远程 SSH 由这台桌面替它升级;远程隧道 / 云电脑请它自己当场换(设备行「重试」同一条)。
      matchServerVersion: (deviceId, options) =>
        currentSshMachineIds().has(deviceId)
          ? requestSshServerUpgrade(deviceId, { force: options?.retry === true })
          : retryServerVersionMatch(deviceId),
    }
    return installRemoteHostsBridge(bridge)
  }, [enabled])
}

function useTunnelState(): TunnelState {
  const [state, setState] = useState<TunnelState>(() => currentTunnelState())
  useEffect(() => {
    setState(currentTunnelState())
    return subscribeTunnelState(setState)
  }, [])
  return state
}

/** 这台桌面上用 SSH 装上的机器(主进程记的本机映射,只算此刻登着的账号);装上新的一台时跟着变。 */
function useSshMachineIds(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => currentSshMachineIds())
  useEffect(() => {
    setIds(currentSshMachineIds())
    return subscribeSshMachineIds(setIds)
  }, [])
  return ids
}

/** 登录没了(失效 / 那台机器上登出 / 被移除)的时刻;还登着或问不到 = null。 */
function signInExpiredAt(state: SshSignInState | undefined): string | null | undefined {
  if (!state) return undefined
  if (state.state === 'expired' || state.state === 'removed') return state.at
  if (state.state === 'signedOut') return null
  return undefined
}

