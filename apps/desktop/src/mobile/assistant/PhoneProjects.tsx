import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import type { DeviceProject } from '@gugu/core/shared/types/deviceProject'
import { listMyDeviceProjects } from '@/lib/deviceProjects'
import { Folder } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { machineHomeLayout } from '@/session/renderer/features/remote-hosts/machine-home'
import { projectGroupLayout, foldProjectGroups } from '@/session/renderer/features/projects/stores/project-group-layout'
import { isImplicitSessionHomeProjectId } from '@/session/shared/core/projects/session-home-project'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { ReadView } from './PhoneMachineView'
import { usePhoneRead } from './usePhoneRead'

type Entry = DeviceProject & { id: string; deviceId: string; label: string }
/** The same home/group folding as the sidebar, using already published account metadata. */
function projectRows(records: Record<string, DeviceProject[]>, devices: readonly Device[]): Entry[] {
  const rows = Object.entries(records).flatMap(([deviceId,projects]) => projects.filter(project => !isImplicitSessionHomeProjectId(project.localProjectId)).map(project => ({ ...project,deviceId,id: `${deviceId}/${project.localProjectId}` })))
  const byId = new Map(rows.map(row => [row.id,row])), byDevice = new Map(devices.map(device => [device.device_id,device]))
  const homes = machineHomeLayout(rows.map(row => ({ id: row.id,path: row.rootPath })),{
    machineOf: id => byId.get(id)!.deviceId,homeDir: id => byDevice.get(id)?.capabilities?.home_dir ?? null,
    isSessionHome: id => isImplicitSessionHomeProjectId(byId.get(id)?.localProjectId),foldAll: id => byDevice.get(id)?.capabilities?.assistant_home === true,
  })
  const groups = projectGroupLayout(rows.map(row => ({ id: row.id,machine: row.deviceId,representative: row.groupRepresentative })),id => byId.get(id)?.chatId ?? undefined)
  const layout = foldProjectGroups(homes,groups)
  return rows.filter(row => !layout.rowOf.has(row.id)).map(row => ({ ...row,
    label: layout.homeRows.has(row.id) ? byDevice.get(row.deviceId)?.label ?? row.name : row.name,
    folders: [row,...rows.filter(other => layout.rowOf.get(other.id) === row.id)].flatMap(member => member.folders),
  }))
}

export function PhoneProjects({ detail = false,onOpen }: { detail?: boolean; onOpen?: () => void; machine?: unknown }) {
  const { t } = useTranslation('assistant')
  const owner = useAuth().user?.id ?? null
  const { devices } = useDevicesStore()
  const read = usePhoneRead(owner ? `account-projects|${owner}` : null,listMyDeviceProjects,'read account project directory',() => 30_000)
  const projects = useMemo(() => projectRows(read.state === 'ok' ? read.data : {},devices),[read,devices])
  const [selected, setSelected] = useState<string | null>(null)
  const current = selected ? projects.find(project => project.id === selected) : null
  if (!detail) return <AssistantRow leading={<Folder />} title={t('library.workspace')} testId="assistant-library-workspace" onClick={onOpen}
    detail={read.state === 'ok' ? t('library.items',{ count: projects.length }) : t(read.state === 'error' ? 'library.failed' : 'library.loading')} />
  if (current) return <PhoneProjectIndex project={current} onBack={() => setSelected(null)} />
  return <div className="ta-page" data-testid="assistant-library-page-workspace">
    <PageHead title={t('library.workspace')} />
    <ReadView read={read} failedTitle={t('library.failed')}>{() => projects.length
      ? <AssistantSection>{projects.map(project => <AssistantRow key={project.id} leading={<Folder />} title={project.label}
        detail={project.rootPath} testId={`assistant-project-${project.id}`} onClick={() => setSelected(project.id)} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.noGuguProjects')}</AssistantEmpty>}</ReadView>
  </div>
}

/** Folder identity is part of device_projects; opening a project performs no device request. */
function PhoneProjectIndex({ project,onBack }: { project: Entry; onBack: () => void }) {
  const { t } = useTranslation('assistant')
  return <div className="ta-page" data-testid="assistant-project-cloud-index">
    <PageHead title={project.label} action={<Button variant="ghost" onClick={onBack}>{t('library.backToIndex')}</Button>} />
    {project.folders.length ? <AssistantSection>{project.folders.map((folder,index) => <AssistantRow key={`${folder.workspaceId}:${index}`}
      leading={<Folder />} title={folder.path.split(/[/\\]/).filter(Boolean).at(-1) ?? folder.path} detail={folder.path} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.emptyContent')}</AssistantEmpty>}
  </div>
}
