import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { PaneBackButton } from '@/components/contacts/ContactDetail'
import { RemoteFolderPicker } from '@/components/RemoteFolderPicker'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Pane, PaneHeader } from '@/components/ui/Pane'
import { useBackLayer } from '@/components/ui/sheetStack'
import { useSessionMessages } from '@/session/renderer/localization/use-session-messages'
import { rendererLogger } from '@/lib/log'
import { notify } from '@/lib/notices'
import { shortHome } from '@/session/shared/path-name'
import { navigateMobile } from '@/mobile/navigateMobile'
import { visibleMachines, workspaceDevices } from '../agent-watch/machine-list'
import { useMachineLabel } from '../agent-watch/useMachineLabel'
import { attachPhoneProjectFolder } from './attachPhoneProjectFolder'
import type { ChatTaskFolders, TaskFolderHome } from './phoneTaskFolders'
import { MAX_PROJECT_FOLDERS, type ShownFolder } from '@/session/renderer/features/projects/components/main-panel/project-folders'

const log = rendererLogger('phone-folder-attach')
type Added = { folder: ShownFolder; home: TaskFolderHome }

/** 新项目和挂文件夹共用机器清单、远端目录树;卡片自身提供机器菜单。 */
export function usePhoneFolderAttach(project: ChatTaskFolders | null, devices: Device[], refresh: () => Promise<void>) {
  const { t } = useTranslation('messaging')
  const { translate: st } = useSessionMessages()
  const { isHome } = useMachineLabel()
  const machines = visibleMachines(workspaceDevices(devices), isHome)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [added, setAdded] = useState<Added[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [merge, setMerge] = useState<{ name: string; count: number; answer: (yes: boolean) => void } | null>(null)
  const mergeRef = useRef(merge)
  mergeRef.current = merge
  useEffect(() => {
    setAdded([]); setDeviceId(null)
    return () => { mergeRef.current?.answer(false) }
  }, [project?.rowId])
  const close = () => { if (!busy) navigateMobile(() => setDeviceId(null), 'pop') }
  useBackLayer(close, !!deviceId)
  const device = devices.find((row) => row.device_id === deviceId)
  const attach = async (path: string) => {
    if (!project || !device || busy) return
    setBusy(true); setError(false)
    try {
      const result = await attachPhoneProjectFolder({ project, devices, device, path,
        confirmMerge: (name, count) => new Promise<boolean>((answer) => setMerge({ name, count, answer: (yes) => { setMerge(null); answer(yes) } })),
      })
      if (result) {
        setAdded((current) => [...current.filter((item) => item.folder.workspaceId !== result.folder.workspaceId), {
          folder: { ...result.folder, attachedAt: result.folder.attachedAt ?? new Date().toISOString(), offline: false, deviceId: device.device_id },
          home: { deviceId: device.device_id, localProjectId: result.folder.projectId, machine: { id: device.device_id, label: device.label || device.hostname, online: true, kind: device.capabilities.host_kind === 'desktop' ? 'computer' : 'server' } },
        }])
        notify({ title: st('projects.folders.attachedOn', { machine: device.label || device.hostname, path: shortHome(result.folder.path), projectName: project.name }), duration: 8000,
          action: { label: st('projects.folders.undo'), onClick: () => {
            void result.undo().then(async (ok) => {
              if (!ok) { notify({ tier: 'error', title: t('composer.phoneTask.attachFailed') }); return }
              setAdded((current) => current.filter((item) => item.folder.workspaceId !== result.folder.workspaceId))
              await refresh()
              notify({ title: st('projects.folders.detached', { path: shortHome(result.folder.path), projectName: project.name }) })
            }).catch((cause) => { log.warn({ error: String(cause) }, 'undo folder attachment failed'); notify({ tier: 'error', title: t('composer.phoneTask.attachFailed') }) })
          } },
        })
        await refresh()
        navigateMobile(() => setDeviceId(null), 'pop')
      }
    } catch (cause) { log.warn({ error: String(cause), deviceId }, 'attach a project folder failed'); setError(true) }
    finally { setBusy(false) }
  }
  const root = document.querySelector('[data-phone-shell]')
  const picker = device && root ? createPortal(
    <div className="gg-phone-folder-picker" data-testid="phone-task-attach-folder">
      <Pane paneRole="detail" mobile className="gg-partners">
        <PaneHeader mobile leading={<PaneBackButton label={t('common.cancel')} onBack={close} />} title={t('composer.phoneTask.attachFolder')} />
        {error ? <p role="alert" className="gg-partners-error">{t('composer.phoneTask.attachFailed')}</p> : null}
        <div className="gg-partners-picker" inert={busy}>
          <RemoteFolderPicker deviceId={device.device_id} initialPath="~" onSelect={(path) => void attach(path)} onCancel={close} />
        </div>
      </Pane>
      <Dialog.Root open={!!merge} onOpenChange={(open) => { if (!open) merge?.answer(false) }}>
        <Dialog.Portal><Dialog.Backdrop /><Dialog.Viewport><Dialog.Popup>
          <Dialog.Title>{st('projects.folders.mergeTitle', { name: merge?.name ?? '', projectName: project?.name ?? '' })}</Dialog.Title>
          <Dialog.Description>{st('projects.folders.mergeDescription', { machine: device.label || device.hostname, name: merge?.name ?? '', count: merge?.count ?? 0, projectName: project?.name ?? '' })}</Dialog.Description>
          <Button variant="ghost" onClick={() => merge?.answer(false)}>{t('common.cancel')}</Button>
          <Button onClick={() => merge?.answer(true)}>{st('projects.folders.mergeConfirm')}</Button>
        </Dialog.Popup></Dialog.Viewport></Dialog.Portal>
      </Dialog.Root>
    </div>, root,
  ) : null
  return {
    added, picker,
    remove: (workspaceId: string) => setAdded((current) => current.filter((item) => item.folder.workspaceId !== workspaceId)),
    fresh: added.at(-1)?.folder.workspaceId,
    attachMachines: machines.map((row) => ({ id: row.device_id, label: row.label || row.hostname, online: row.is_online, kind: row.capabilities.host_kind === 'desktop' ? 'computer' as const : 'server' as const })),
    onAttach: (id: string | null) => {
      // 挂满了就当场说,❌ 先推目录页、挑完才拒(同电脑 #629;各台机器合计,含这一页刚挂上的)。
      const count = new Set([...(project?.folders ?? []), ...added.map((item) => item.folder)].map((folder) => folder.workspaceId)).size
      if (project && count >= MAX_PROJECT_FOLDERS) {
        notify({ tier: 'error', title: st('projects.folders.errorFull', { projectName: project.name, max: MAX_PROJECT_FOLDERS }) })
        return
      }
      setError(false); navigateMobile(() => setDeviceId(id), 'push')
    },
  }
}
