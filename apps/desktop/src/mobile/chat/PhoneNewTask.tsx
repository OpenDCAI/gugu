import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { remoteFailureKind, type SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { EngineIcon } from '@/components/AgentHarnessIdentity'
import type { ComposerAttachAction } from '@/components/chat/ComposerAttachButton'
import { useToast } from '@/components/toastContext'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { DropdownMenu, MenuItem } from '@/components/ui/Menu'
import { Check, ChevronDown, Folder, X } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { requestTopicSplit } from '@/lib/topicSplitRequest'
import { useDevicesStore } from '@/store/devicesContext'
import { ProjectFolderCard } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { ProjectFoldersState, ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders'
import { TaskInGroupError, createTaskInGroup } from '../agent-watch/createTaskInGroup'
import { harnessUsable, initialSelection } from '../agent-watch/create-session-form'
import { SessionpageRpcError, fetchCreateOptions } from '../agent-watch/sessionpage-rpc'
import { taskFoldersOfChat } from './phoneTaskFolders'
import './phone-new-task.css'

const log = rendererLogger('phone-new-task')
const NO_ATTACH: never[] = []

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

/** off = 发消息;on = 新任务的框(folder 还没点 = 卡浮着等你点;picking = 卡浮着)。 */
type Stage = { kind: 'off' } | { kind: 'on'; folder: ShownFolder | null; picking: boolean }

/**
 * 手机在项目群里派「新任务」(spec mobile-session-view「新任务照电脑」,OpenDCAI/gugu#446):
 * 回形针菜单「新任务」→ 框换成新任务的框(上沿一枚「新任务 · agent ▾」),这个项目的文件夹卡(电脑上那一张,
 * ProjectFolderCard)浮在群上 → 点一张文件夹,标签旁写明它在哪台机器上(spec:新建任务的地方写明在哪台机器上运行;点它重新挑)→
 * 发出去 = 那台机器那个文件夹里开工,卡落进群、从卡上开出话题,页签切到它(原型 v7.12)。
 * 打字不收卡(spec projects「项目首页」);收卡只有点一张文件夹,或标签上的 × 连新任务一起收。
 */
export function usePhoneNewTask({ chatId, enabled, clear }: {
  chatId: string | null | undefined
  /** 手机上、群的主输入框。 */
  enabled: boolean
  /** 发出去之后清空输入框。 */
  clear: () => void
}): {
  action: ComposerAttachAction | null
  active: boolean
  placeholder: string | undefined
  /** 浮在输入框上面的文件夹卡。 */
  overlay: ReactNode
  /** 框上沿那一枚任务标签。 */
  band: ReactNode
  send: (text: string) => Promise<void>
} {
  const { t } = useTranslation('messaging')
  const { toast } = useToast()
  const { devices } = useDevicesStore()
  const project = useMemo(() => (enabled && chatId ? taskFoldersOfChat(devices, chatId) : null), [enabled, chatId, devices])
  const [stage, setStage] = useState<Stage>({ kind: 'off' })
  const [options, setOptions] = useState<{ deviceId: string; value: SessionpageSessionCreateOptions | null; failed: boolean } | null>(null)
  const [harness, setHarness] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  useEffect(() => { setStage({ kind: 'off' }) }, [chatId])

  const chosen = stage.kind === 'on' ? stage.folder : null
  const home = chosen ? project?.homeOf(chosen.projectId) : undefined
  const deviceId = home?.deviceId ?? null
  const online = home?.machine.online ?? false
  // 点中一张文件夹:读那台机器上能用的 agent(同手机新建会话页那一份),默认沿用上次的。
  useEffect(() => {
    if (!deviceId || !online) { setOptions(null); return }
    let live = true
    setOptions({ deviceId, value: null, failed: false })
    fetchCreateOptions(deviceId).then(
      (value) => {
        if (!live) return
        setOptions({ deviceId, value, failed: false })
        setHarness(initialSelection(value).harness)
      },
      (error: unknown) => {
        log.warn({ error: String(error), deviceId }, 'read the agents on that machine failed')
        if (live) setOptions({ deviceId, value: null, failed: true })
      },
    )
    return () => { live = false }
  }, [deviceId, online])

  const usable = options?.value?.harnesses.filter(harnessUsable) ?? []
  const picked = usable.find((option) => option.id === harness) ?? null
  const machine = home?.machine.label ?? ''
  const blocked = !chosen ? t('composer.phoneTask.pickFolder')
    : !online ? t('composer.phoneTask.offline', { machine })
    : options?.failed ? t('composer.phoneTask.optionsFailed', { machine })
      : options?.value && usable.length === 0 ? t('composer.phoneTask.noAgent', { machine })
        : null

  const folderState: ProjectFoldersState | null = project ? {
    folders: project.folders,
    loadError: false,
    chosen,
    fresh: undefined,
    choose: (workspaceId) => {
      const folder = project.folders.find((candidate) => candidate.workspaceId === workspaceId)
      if (folder) setStage({ kind: 'on', folder, picking: false })
    },
    reload: () => undefined,
    // 手机上的卡不挂文件夹(没有「+」,见 phone-new-task.css);挂文件夹在电脑上做。
    attach: async () => ({ ok: false, error: { type: 'rpc-failed', message: 'attaching folders is not offered on the phone' } }),
    detach: async () => false,
  } : null

  const overlay = stage.kind === 'on' && stage.picking && project && folderState ? (
    <div className="gg-phone-task-card" data-testid="phone-task-folder-card">
      <ProjectFolderCard
        projectId={project.rowId}
        projectName={project.name}
        folders={folderState}
        memberIds={project.memberIds}
        machineOf={(id) => project.homeOf(id)?.machine ?? { label: '', online: false, kind: 'computer' }}
        attachMachines={NO_ATTACH}
        onAttach={() => undefined}
        onDropFolder={() => undefined}
        floating
      />
    </div>
  ) : null

  const agentName = picked?.name ?? ''
  const band = stage.kind === 'on' ? (
    <div className="gg-phone-task-tag" data-testid="phone-task-tag">
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger className="gg-phone-task-chip" aria-label={t('composer.phoneTask.pickAgent')} disabled={usable.length === 0 || sending}>
          {picked ? <EngineIcon engine={picked.id} size={14} /> : null}
          <span>{picked ? t('composer.phoneTask.chip', { agent: picked.name }) : t('composer.phoneTask.action')}</span>
          {usable.length > 1 ? <ChevronDown size={14} /> : null}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content side="top" align="start" sideOffset={8}>
          {usable.map((option) => (
            <MenuItem key={option.id} icon={option.id === harness ? <Check size={16} /> : <EngineIcon engine={option.id} size={16} />} onClick={() => setHarness(option.id)}>{option.name}</MenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
      <Button variant="ghost" className="gg-phone-task-where" data-blocked={blocked ? '' : undefined} data-testid="phone-task-where"
        onClick={() => setStage({ kind: 'on', folder: chosen, picking: true })}>
        <Folder size={14} aria-hidden />
        <span>{blocked ?? t('composer.phoneTask.where', { folder: folderName(chosen!.path), machine })}</span>
      </Button>
      <IconButton size="sm" aria-label={t('composer.phoneTask.cancel')} onClick={() => setStage({ kind: 'off' })}><X size={14} /></IconButton>
    </div>
  ) : null

  const send = async (text: string) => {
    const prompt = text.trim()
    if (stage.kind !== 'on' || !chatId || !prompt || sending) return
    if (blocked || !home || !chosen || !picked) { toast(blocked ?? t('composer.phoneTask.loading', { machine }), 'error'); return }
    setSending(true)
    try {
      const { topicChatId } = await createTaskInGroup({
        deviceId: home.deviceId, projectId: home.localProjectId, cwd: chosen.path, chatId, prompt, harness: picked.id,
      })
      clear()
      setStage({ kind: 'off' })
      // 开工了:页签切到它那一枚(群页从这个盒子里取走,同列表点话题那一路)。
      requestTopicSplit({ chatId: topicChatId, name: prompt, sourceChatId: chatId })
    } catch (error) {
      log.warn({ error: String(error), chatId, deviceId: home.deviceId }, 'dispatch a task from the phone failed')
      if (error instanceof TaskInGroupError) {
        toast(t(`composer.phoneTask.failed.${error.code}`, { machine }), 'error')
        if (error.code !== 'host_outdated') { clear(); setStage({ kind: 'off' }) }
      } else {
        const code = error instanceof SessionpageRpcError ? error.code : null
        toast(t(`agentWatch.create.failure.${remoteFailureKind(code)}`, { ns: 'main' }), 'error')
      }
    } finally {
      setSending(false)
    }
  }

  return {
    action: project && stage.kind === 'off'
      ? { id: 'phone-new-task', label: t('composer.phoneTask.action'), icon: <Folder size={16} />, onSelect: () => setStage({ kind: 'on', folder: null, picking: true }) }
      : null,
    active: stage.kind !== 'off',
    placeholder: stage.kind === 'on' && agentName ? t('composer.phoneTask.placeholder', { agent: agentName }) : undefined,
    overlay,
    band,
    send,
  }
}
