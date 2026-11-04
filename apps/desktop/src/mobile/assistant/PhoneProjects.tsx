import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listMyDeviceProjects } from '@/lib/deviceProjects'
import { Folder } from '@/lib/icons'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/store/auth'
import { useDevicesStore } from '@/store/devicesContext'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '@/session/renderer/features/assistant/assistant-ui-parts'
import { ReadView } from './PhoneMachineView'
import { phoneProjectRows, type PhoneProjectEntry } from './phoneProjectRows'
import { usePhoneRead } from './usePhoneRead'

export function PhoneProjects({ detail = false,onOpen }: { detail?: boolean; onOpen?: () => void; machine?: unknown }) {
  const { t } = useTranslation('assistant')
  const owner = useAuth().user?.id ?? null
  const { devices,cloudComputer } = useDevicesStore()
  // The assistant's cloud host, same source as usePhoneAssistant / useMachineLabel (not where the assistant lives:
  // an assistant living on the person's own computer must not hide that computer's projects).
  const cloudDeviceId = cloudComputer?.snapshot?.deviceId ?? devices.find(device => device.cloud_computer)?.device_id ?? null
  const read = usePhoneRead(owner ? `account-projects|${owner}` : null,listMyDeviceProjects,'read account project directory',() => 30_000)
  const projects = useMemo(() => phoneProjectRows(read.state === 'ok' ? read.data : {},devices,cloudDeviceId),[read,devices,cloudDeviceId])
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
function PhoneProjectIndex({ project,onBack }: { project: PhoneProjectEntry; onBack: () => void }) {
  const { t } = useTranslation('assistant')
  return <div className="ta-page" data-testid="assistant-project-cloud-index">
    <PageHead title={project.label} action={<Button variant="ghost" onClick={onBack}>{t('library.backToIndex')}</Button>} />
    {project.folders.length ? <AssistantSection>{project.folders.map((folder,index) => <AssistantRow key={`${folder.workspaceId}:${index}`}
      leading={<Folder />} title={folder.path.split(/[/\\]/).filter(Boolean).at(-1) ?? folder.path} detail={folder.path} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.emptyContent')}</AssistantEmpty>}
  </div>
}
