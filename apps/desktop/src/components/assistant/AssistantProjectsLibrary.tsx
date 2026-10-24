import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from '../../lib/icons'
import { Button } from '../ui/Button'
import { useDevicesStore } from '../../store/devicesContext'
import { deviceSessionsOf, useLiveDeviceSessions } from '../../session/shared/remote-sessions/session-directory'
import { isImplicitSessionHomeProjectId } from '../../session/shared/core/projects/session-home-project'
import { machineRpc } from '../../mobile/agent-watch/sessionpage-rpc'
import { usePhoneRead } from '../../mobile/assistant/usePhoneRead'
import { PhoneProjectDirectoryRetry } from '../../mobile/assistant/PhoneProjectDirectoryRetry'
import { useAuth } from '../../store/auth'
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '../../session/renderer/features/assistant/assistant-ui-parts'

type Props = { machine: AssistantMachine | null | undefined; onOpen?: () => void; askInChat?: (text: string) => void }
type ProjectEntry = { id: string; name: string; deviceId: string; path: string }

/** Project identity is the existing sidebar's identity; Filesystem folders never create project rows. */
export function AssistantProjectsCard(props: Props) {
  return <DirectoryProjects {...props} />
}
export function AssistantProjectsLibrary(props: Props) {
  return <DirectoryProjects {...props} detail />
}

function DirectoryProjects({ machine, detail = false, onOpen }: Props & { detail?: boolean }) {
  const { t } = useTranslation('assistant')
  const ownerId = useAuth().user?.id ?? null
  const { devices, loading, error } = useDevicesStore()
  const live = useLiveDeviceSessions()
  const [selected, setSelected] = useState<ProjectEntry | null>(null)
  const directory = devices.map(device => deviceSessionsOf(device, live))
  const unread = loading || directory.some(item => item.loading)
  const failed = error || directory.find(item => item.error)?.error
  const failedDeviceIds = devices.filter(device => device.is_online && deviceSessionsOf(device, live).error).map(device => device.device_id)
  const projects = devices.flatMap(device => deviceSessionsOf(device, live).projects
    .filter(project => !isImplicitSessionHomeProjectId(project.id) && !(device.device_id === machine?.deviceId && project.id === machine.projectId))
    .map(project => ({ ...project, deviceId: device.device_id })))
  if (!detail) return <AssistantRow leading={<Folder />} title={t('library.workspace')}
    detail={failed ? t('library.failed') : unread ? t('library.loading') : t('library.items', { count: projects.length })} onClick={onOpen} testId="assistant-library-workspace" />
  if (selected) return <PhoneProjectIndex key={`${selected.deviceId}/${selected.id}`} project={selected} onBack={() => setSelected(null)} />
  return <div className="ta-page" data-testid="assistant-library-page-workspace">
    <PageHead title={t('library.workspace')} sub={t('library.guguProjects')} />
    {failed ? <AssistantEmpty action={<PhoneProjectDirectoryRetry key={ownerId} deviceIds={error ? [] : failedDeviceIds} />}><span role="alert">{t('library.failed')}</span></AssistantEmpty> : unread ? <AssistantEmpty>{t('library.loading')}</AssistantEmpty>
      : projects.length ? <AssistantSection>{projects.map(project => <AssistantRow key={`${project.deviceId}/${project.id}`} leading={<Folder />}
        testId={`assistant-project-${project.id}`} title={project.name} detail={devices.find(device => device.device_id === project.deviceId)?.label} onClick={() => setSelected(project)} />)}</AssistantSection>
      : <AssistantEmpty>{t('library.noGuguProjects')}</AssistantEmpty>}
  </div>
}

/** Reads that registered project's own folder index over the normal device RPC. */
function PhoneProjectIndex({ project, onBack }: { project: ProjectEntry; onBack: () => void }) {
  const { t } = useTranslation('assistant')
  const read = usePhoneRead(`${project.deviceId}|${project.id}|folders`, async () => {
    const answer = await machineRpc(project.deviceId).projects.listProjectFolders(project.id)
    if (!answer.success) throw new Error(answer.error.message)
    return answer.data
  }, 'read Gugu project index')
  return <div className="ta-page">
    <PageHead title={project.name} action={<Button variant="ghost" onClick={onBack}>{t('library.backToIndex')}</Button>} />
    {read.state === 'error' ? <AssistantEmpty action={<Button onClick={read.reload}>{t('machine.retry')}</Button>}>{t('library.failed')}</AssistantEmpty>
      : read.state === 'loading' ? <AssistantEmpty>{t('library.loading')}</AssistantEmpty>
      : <AssistantSection>{read.data.map(folder => <AssistantRow key={folder.workspaceId} leading={<Folder />} title={folder.path.split(/[/\\]/).filter(Boolean).at(-1) ?? folder.path}
        detail={t('library.projectFolderSessions', { count: folder.sessionIds.length })} />)}</AssistantSection>}
  </div>
}
