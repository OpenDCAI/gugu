import { useEffect, useState } from 'react'
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import type { Device } from '@gugu/core/shared/types/chat'
import { rendererLogger } from '@/lib/log'
import { isAssistantSession } from '@/session/renderer/features/assistant/assistant-lineage'
import { openMachineWith, type AssistantMachine, type MachineRpc } from '@/session/renderer/features/assistant/assistant-machine-core'
import { deviceSessionsOf, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { useDevicesStore } from '@/store/devicesContext'
import { machineRpc } from '../agent-watch/sessionpage-rpc'

const log = rendererLogger('mobile/assistant')

/** 它家那台此刻能不能读:醒着 / 收回着(云上的才有,要读就由系统叫起来)/ 正在起来 / 连不上(离线、还没有这台;住电脑 = 那台没开)。 */
export type PhoneReadiness = 'ready' | 'asleep' | 'waking' | 'unreachable'

export function readinessOf(device: Pick<Device, 'is_online' | 'cloud_computer'> | null): PhoneReadiness {
  if (!device) return 'unreachable'
  if (device.cloud_computer === 'asleep') return 'asleep'
  if (device.cloud_computer === 'waking') return 'waking'
  return device.is_online ? 'ready' : 'unreachable'
}

export function useCloudDevice(homeDeviceId: string | null): Device | null {
  const { devices } = useDevicesStore()
  return homeDeviceId ? devices.find((device) => device.device_id === homeDeviceId) ?? null : null
}

/**
 * 那台机器上的主目录项目(没有就建一个,与桌面 remoteHostsStore.ensureHomeProject 同一步:同路径已有项目就复用)。
 * 住云上时读写它家里的东西(~/.claude/projects/<目录>/memory、~/给助理的资料、voice-notes/)都要落在**这个**项目的工作区里:
 * 写 / 建夹 / 分块上传只认工作区之内(读才走 readExternalFile),而助理自己那条会话的项目是它的工作目录,记忆夹在它之外。
 */
export async function homeProjectIdOn(rpc: MachineRpc, home: string): Promise<string> {
  const inspection = await rpc.projects.inspectProjectPath({ type: 'local', path: home })
  if (inspection.existingProject) return inspection.existingProject.id
  if (inspection.pathConflict) throw new Error('home directory conflicts with an existing project')
  const created = await rpc.projects.createProject({
    type: 'local',
    id: crypto.randomUUID(),
    path: home,
    name: home.replace(/\/+$/, '').split('/').pop() || home,
    createDirectory: false,
    initGitRepository: false,
    allowNonGit: true,
  })
  if (!created.success) throw new Error(`could not add ${home} as a project: ${String(created.error.type)}`)
  return created.data.id
}

export type PhoneMachineState =
  | { state: 'opening' }
  | { state: 'ready'; machine: AssistantMachine }
  /** 云电脑上找不到它自己的会话(工作目录跟着那条会话走):如实说,❌ 退回主目录读一片空。 */
  | { state: 'no-workdir' }
  | { state: 'error'; error: unknown; retry: () => void }

/**
 * 在它家那台上拿到读它文件用的工作区:它自己那条会话所在的项目(手机壳没有会话页的项目表,❌ 另挂主目录项目),
 * 主目录问那台机器。问的是手机壳的那条线(machineRpc),与桌面同一组动词。醒着才问。
 */
export function usePhoneMachine(homeDeviceId: string | null, assistantId: string, readiness: PhoneReadiness, kind: AssistantHomeKind = 'cloud'): PhoneMachineState {
  const live = useLiveDeviceSessions()
  const device = useCloudDevice(homeDeviceId)
  const listed = device ? deviceSessionsOf(device, live) : null
  const own = listed?.sessions.find((session) => isAssistantSession(session, assistantId)) ?? null
  const workdir = own ? listed?.projects.find((project) => project.id === own.projectId)?.path ?? null : null
  const projectId = own?.projectId ?? null
  const [attempt, setAttempt] = useState(0)
  const [opened, setOpened] = useState<{ key: string; result: PhoneMachineState } | null>(null)
  const key = `${homeDeviceId}|${kind}|${projectId}|${workdir}|${attempt}`
  useEffect(() => {
    if (readiness !== 'ready' || !homeDeviceId || !projectId || !workdir) return
    let cancelled = false
    const rpc: MachineRpc = machineRpc(homeDeviceId)
    void (async () => {
      try {
        const home = await rpc.app.getHomeDirectory()
        // 云上:读写落在主目录项目的工作区(记忆夹在助理工作目录之外);住电脑:它的一切都在它自己的工作目录里,用那个项目。
        const workspaceProjectId = kind === 'cloud' ? await homeProjectIdOn(rpc, home) : projectId
        const machine = await openMachineWith(rpc, { deviceId: homeDeviceId, projectId: workspaceProjectId, home, workdir, kind })
        if (!cancelled) setOpened({ key, result: { state: 'ready', machine } })
      } catch (error) {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'open assistant machine failed')
        if (!cancelled) setOpened({ key, result: { state: 'error', error, retry: () => setAttempt((n) => n + 1) } })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [readiness, homeDeviceId, projectId, workdir, kind, key])
  if (readiness === 'ready' && listed && !listed.loading && !own) return { state: 'no-workdir' }
  if (opened?.key === key) return opened.result
  return { state: 'opening' }
}
