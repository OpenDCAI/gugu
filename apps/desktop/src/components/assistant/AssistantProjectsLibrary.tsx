import { PhoneProjects } from '../../mobile/assistant/PhoneProjects'
import { observer } from 'mobx-react-lite'
import { useTranslation } from 'react-i18next'
import { Folder } from '../../lib/icons'
import { platform } from '../../platform'
import { Button } from '../ui/Button'
import { appState } from '../../session/renderer/lib/stores/app-state'
import { revealSessionpage } from '../../hooks/useSessionpageReveal'
import type { AssistantMachine } from '../../session/renderer/features/assistant/assistant-machine-core'
import { AssistantEmpty, AssistantRow, AssistantSection, PageHead } from '../../session/renderer/features/assistant/assistant-ui-parts'

type Props = { machine: AssistantMachine | null | undefined; onOpen?: () => void; askInChat?: (text: string) => void }

/** Project identity is the existing sidebar's identity; Filesystem folders never create project rows. */
export function AssistantProjectsCard(props: Props) {
  return platform.capabilities.agentRuntime ? <NativeProjects {...props} /> : <PhoneProjects {...props} />
}
export function AssistantProjectsLibrary(props: Props) {
  return platform.capabilities.agentRuntime ? <NativeProjects {...props} detail /> : <PhoneProjects {...props} detail />
}

const NativeProjects = observer(function NativeProjects({ detail = false, onOpen, askInChat }: Props & { detail?: boolean }) {
  const { t } = useTranslation('assistant')
  const projects = appState.sidebar.orderedProjects.filter(project => !appState.sidebar.homeLayout.homeRows.has(project.id))
  if (!detail) return <AssistantRow leading={<Folder />} title={t('library.workspace')} detail={t('library.items', { count: projects.length })} onClick={onOpen} testId="assistant-library-workspace" />
  return <div className="ta-page" data-testid="assistant-library-page-workspace">
    <PageHead title={t('library.workspace')} sub={t('library.guguProjects')} />
    {projects.length ? <AssistantSection>{projects.map(project => <AssistantRow key={project.id} leading={<Folder />}
      title={appState.sidebar.projectLabel(project.id) ?? project.name ?? t('library.workspace')} detail={project.data?.path}
      testId={`assistant-project-${project.id}`} onClick={() => {
        appState.navigation.navigate('project', { projectId: project.id })
        appState.sidebar.ensureProjectExpanded(project.id)
        revealSessionpage()
      }} />)}</AssistantSection> : <AssistantEmpty action={askInChat && <Button onClick={() => askInChat(t('library.projectOrganizePrompt'))}>{t('library.organize')}</Button>}>{t('library.noGuguProjects')}</AssistantEmpty>}
  </div>
})
