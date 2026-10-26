import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PaneBackButton } from '@/components/contacts/ContactDetail'
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker'
import { Button } from '@/components/ui/Button'
import { Menu, MenuItem } from '@/components/ui/Menu'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { ChevronRight, Folder, FolderPlus, Monitor } from '@/lib/icons'
import { rendererLogger } from '@/lib/log'
import { navigateMobile } from '@/mobile/navigateMobile'
import { useMachineLabel } from '@/mobile/agent-watch/useMachineLabel'
import { visibleMachines, workspaceDevices } from '@/mobile/agent-watch/machine-list'
import { shortHome } from '@/session/shared/path-name'
import { useDevicesStore } from '@/store/devicesContext'
import { newProjectPath, projectNameProblem } from './partnersModel'
import { ProjectFolderAvatar } from './ProjectFolderAvatar'
import { projectRpcOn } from './projectRpc'

export type CreatedProject = { chatId: string | null; deviceId: string; localProjectId: string; name: string; createdAt: string }

const LAST_MACHINE_KEY = 'gugu.partners.newProjectMachine'
const log = rendererLogger('partners/new-project')

function readLastMachine(): string | null {
  try { return globalThis.localStorage?.getItem(LAST_MACHINE_KEY) ?? null } catch { return null }
}

function writeLastMachine(deviceId: string): void {
  try { globalThis.localStorage?.setItem(LAST_MACHINE_KEY, deviceId) } catch { /* 记不住上次那台只影响下次的默认 */ }
}

type Directory = { deviceId: string; path: string | null; failed: boolean }

/**
 * 手机「新项目」(OpenDCAI/gugu#446):名字 + 机器 + 文件夹。项目一定有文件夹(owner 10-26「新建项目我们不存在空文件夹的情况」):
 * 默认在那台机器的默认项目目录下新建一个跟项目同名的空文件夹,也可以选那台机器上已有的文件夹。机器默认上次那台,离线的点不了。
 * 建法同电脑「新建项目」(create-project-name-modal):那台机器上建项目、再把项目群备好。出错在原处说一次。
 */
export function PhoneNewProjectPage({ active, onBack, onCreated }: {
  active: boolean
  onBack: () => void
  onCreated: (project: CreatedProject) => void
}) {
  const { t } = useTranslation('main')
  const { devices, refresh } = useDevicesStore()
  const { label: machineLabel, isHome } = useMachineLabel()
  const machines = useMemo(() => visibleMachines(workspaceDevices(devices), isHome), [devices, isHome])
  // 头像按这个 id 取色,建出来的项目也用它:建好前后是同一张封面。
  const [projectId] = useState(() => crypto.randomUUID())
  const [name, setName] = useState('')
  const [pickedMachineId, setPickedMachineId] = useState<string | null>(readLastMachine)
  const [existingFolder, setExistingFolder] = useState<{ deviceId: string; path: string } | null>(null)
  const [directory, setDirectory] = useState<Directory | null>(null)
  const [menu, setMenu] = useState<'machine' | 'folder' | null>(null)
  const [picking, setPicking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const machineRow = useRef<HTMLButtonElement>(null)
  const folderRow = useRef<HTMLButtonElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)

  const device = machines.find((row) => row.device_id === pickedMachineId && row.is_online) ?? machines.find((row) => row.is_online) ?? null
  const deviceId = device?.device_id ?? null
  const folderPath = existingFolder && existingFolder.deviceId === deviceId ? existingFolder.path : null
  const shownDirectory = directory && directory.deviceId === deviceId ? directory : null

  // 那台机器的默认项目目录(它自己的设置,同电脑设置 → 机器 → 默认项目目录)。
  useEffect(() => {
    if (!device) return
    let cancelled = false
    const id = device.device_id
    projectRpcOn(device).appSettings.getWithMeta('localProject')
      .then((meta) => {
        const path = (meta as { value?: { defaultProjectsDirectory?: string } } | undefined)?.value?.defaultProjectsDirectory?.trim()
        if (!cancelled) setDirectory({ deviceId: id, path: path || null, failed: false })
      })
      .catch(() => { if (!cancelled) setDirectory({ deviceId: id, path: null, failed: true }) })
    return () => { cancelled = true }
  }, [deviceId]) // eslint-disable-line react-hooks/exhaustive-deps -- 设备行每刷新一次就是新对象,按机器认

  const trimmed = name.trim()
  const placeholder = t('partners.newProject.title')
  const folderValue = folderPath
    ? shortHome(folderPath)
    : shownDirectory?.path
      ? shortHome(newProjectPath(shownDirectory.path, trimmed || placeholder))
      : shownDirectory
        ? t('partners.newProject.noDefaultDirectory')
        : device ? t('partners.newProject.readingDirectory') : ''

  const create = async () => {
    if (!device || creating) return
    const problem = projectNameProblem(trimmed)
    if (problem === 'empty') { nameInput.current?.focus(); return }
    if (problem === 'invalid') { setError(t('partners.newProject.invalidName')); return }
    const path = folderPath ?? (shownDirectory?.path ? newProjectPath(shownDirectory.path, trimmed) : null)
    if (!path) { setError(t('partners.newProject.noDefaultDirectory')); return }
    setCreating(true)
    setError(null)
    try {
      const rpc = projectRpcOn(device)
      const inspection = await rpc.projects.inspectProjectPath({ type: 'local', path })
      let created: { id: string; name: string } = { id: projectId, name: trimmed }
      if (inspection.existingProject) {
        // 那个文件夹已经是一个项目:就是它(同电脑「新建项目」)。
        created = { id: inspection.existingProject.id, name: inspection.existingProject.name }
        if (inspection.existingProject.rootFolderDetached) {
          const attached = await rpc.projects.attachProjectFolder(created.id, path)
          if (!attached.success) throw new Error(attached.error.message)
        }
      } else if (inspection.pathConflict) {
        setError(t('partners.newProject.pathTaken', { name: inspection.pathConflict.name }))
        setCreating(false)
        return
      } else {
        const result = await rpc.projects.createProject({ type: 'local', id: projectId, path, name: trimmed, createDirectory: !folderPath, allowNonGit: true })
        if (!result.success) throw new Error('message' in result.error ? result.error.message : result.error.type)
      }
      const group = await rpc.projects.ensureProjectGroup(created.id)
      writeLastMachine(device.device_id)
      void refresh()
      onCreated({ chatId: group.success ? group.data.chatId : null, deviceId: device.device_id, localProjectId: created.id, name: created.name, createdAt: new Date().toISOString() })
    } catch (cause) {
      // 原因进日志;页面上只说没建成(#4891 同一条)。
      log.warn({ err: String(cause) }, 'create project failed')
      setError(t('partners.newProject.failed'))
      setCreating(false)
    }
  }

  if (picking && device) {
    const closePicker = () => navigateMobile(() => setPicking(false), 'pop')
    return (
      <Pane paneRole="detail" mobile className="gg-partners" data-testid="phone-new-project-folder">
        <PaneHeader mobile leading={<PaneBackButton label={t('shell.back')} onBack={closePicker} />} title={t('partners.newProject.pickFolder')} />
        <div className="gg-partners-picker">
          <RemoteFolderPicker
            deviceId={device.device_id}
            initialPath={shownDirectory?.path ?? '~'}
            onSelect={(path) => navigateMobile(() => { setExistingFolder({ deviceId: device.device_id, path }); setPicking(false) }, 'pop')}
            onCancel={closePicker}
          />
        </div>
      </Pane>
    )
  }

  return (
    <Pane paneRole="detail" mobile className="gg-partners" data-testid="phone-new-project">
      <PaneHeader
        mobile
        leading={<PaneBackButton label={t('shell.back')} onBack={onBack} />}
        title={t('partners.newProject.title')}
        actions={
          <Button variant="primary" size="sm" disabled={!device || !trimmed || creating} onClick={() => void create()} data-testid="phone-new-project-create">
            {t('partners.newProject.create')}
          </Button>
        }
      />
      <div className="gg-partners-scroll">
        <div className="gg-partners-new-hero">
          <ProjectFolderAvatar coverId={projectId} size={64} />
          <input
            ref={nameInput}
            className="gg-partners-name-input"
            aria-label={t('partners.newProject.name')}
            placeholder={placeholder}
            value={name}
            autoFocus={active}
            onChange={(event) => { setName(event.target.value); setError(null) }}
            onKeyDown={(event) => { if (event.key === 'Enter') void create() }}
          />
        </div>
        <div className="gg-partners-navrows">
          <Button ref={machineRow} variant="ghost" size="option" className="gg-partners-navrow" disabled={!machines.length} onClick={() => setMenu('machine')} data-testid="phone-new-project-machine">
            <span className="gg-partners-navrow-icon"><Monitor size={20} /></span>
            <span className="gg-partners-navrow-label">{t('partners.newProject.machine')}</span>
            <span className="gg-partners-row-value">{device ? machineLabel(device) : t('partners.newProject.noMachine')}</span>
            <ChevronRight size={16} aria-hidden className="gg-partners-navrow-chevron" />
          </Button>
          <Button ref={folderRow} variant="ghost" size="option" className="gg-partners-navrow" disabled={!device} onClick={() => setMenu('folder')} data-testid="phone-new-project-folder-row">
            <span className="gg-partners-navrow-icon">{folderPath ? <Folder size={20} /> : <FolderPlus size={20} />}</span>
            <span className="gg-partners-navrow-label">{t('partners.newProject.folder')}</span>
            <span className="gg-partners-row-value" title={folderPath ?? undefined}>{folderValue}</span>
            <ChevronRight size={16} aria-hidden className="gg-partners-navrow-chevron" />
          </Button>
        </div>
        {error ? <p className="gg-partners-error" role="alert">{error}</p> : null}
      </div>
      {menu === 'machine' ? (
        <Menu anchor={machineRow} onClose={() => setMenu(null)}>
          {machines.map((row) => (
            <MenuItem key={row.device_id} icon={<Monitor size={15} />} disabled={!row.is_online}
              onClick={() => { setPickedMachineId(row.device_id); setError(null) }}>
              {machineLabel(row)}
              {row.is_online ? null : <span className="gg-partners-menu-note">{t('partners.newProject.offline')}</span>}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {menu === 'folder' ? (
        <Menu anchor={folderRow} onClose={() => setMenu(null)}>
          <MenuItem icon={<FolderPlus size={15} />} onClick={() => { setExistingFolder(null); setError(null) }}>{t('partners.newProject.newFolder')}</MenuItem>
          <MenuItem icon={<Folder size={15} />} onClick={() => navigateMobile(() => setPicking(true), 'push')}>{t('partners.newProject.existingFolder')}</MenuItem>
        </Menu>
      ) : null}
    </Pane>
  )
}
