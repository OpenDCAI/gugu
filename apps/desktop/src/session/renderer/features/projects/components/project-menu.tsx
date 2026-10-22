import { ChevronDown, Ellipsis, ExternalLink, Globe, Trash2 } from '@/lib/icons'
import { GithubIcon } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project'
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants'
import {
  asMounted,
  getProjectStore,
  getGitRepositoryStore,
  projectDisplayName
} from '@renderer/features/projects/stores/project-selectors'
import { rpc } from '@renderer/lib/ipc'
import { useNavigate } from '@renderer/lib/layout/navigation-provider'
import { Button } from '@renderer/lib/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu'
import { Separator } from '@renderer/lib/ui/separator'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { isGitHubDotComHost, parseRepositoryRef } from '@shared/repository-ref'

const MountedProjectTitlebarLeft = observer(function ProjectTitlebarLeft({
  projectId
}: {
  projectId: string
}) {
  const { navigate } = useNavigate()
  const { translate } = useSessionMessages()
  const store = getProjectStore(projectId)
  const displayName = projectDisplayName(store) ?? translate('projects.fallbackName')
  const confirmDeleteProject = useConfirmDeleteProject()

  const repo = getGitRepositoryStore(projectId)
  const baseRemote = repo?.baseRemote
  const remoteUrl = baseRemote?.url
  const repositoryUrl = repo?.canonicalRepositoryUrl
  const repository = parseRepositoryRef(repositoryUrl)

  const isGithubUrl = repository ? isGitHubDotComHost(repository.host) : false
  const repoLabel = repository?.nameWithOwner ?? remoteUrl?.replace(/^https?:\/\//, '')

  return (
    <div className="flex h-full items-center gap-2 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="group flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
              <span className="text-sm">{displayName}</span>
              <ChevronDown className="size-3.5" />
            </button>
          }
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-40">
          <DropdownMenuItem
            className="flex items-center gap-2 text-foreground-destructive"
            onClick={() => {
              void confirmDeleteProject({
                projectId,
                projectLabel: displayName,
                onDeleted: () => navigate('home')
              })
            }}
          >
            <Trash2 className="size-4" />
            {translate('projects.titlebar.remove')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {remoteUrl && (
        <>
          <Separator
            orientation="vertical"
            className="h-4 data-[orientation=vertical]:self-center"
          />
          <Button
            variant="ghost"
            className="group flex items-center gap-1.5 text-sm text-foreground-muted transition-colors hover:text-foreground"
            onClick={() =>
              void rpc.app.openExternal(
                isGithubUrl ? (repository?.repositoryUrl ?? remoteUrl ?? '') : (remoteUrl ?? '')
              )
            }
          >
            <div className="flex items-center gap-1 text-sm">
              {isGithubUrl ? <GithubIcon className="size-3.5" /> : <Globe className="size-3.5" />}
              <span className="truncate">{repoLabel}</span>
            </div>
            <ExternalLink className="size-3.5 shrink-0 text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground" />
          </Button>
        </>
      )}
    </div>
  )
})

/**
 * 项目菜单(项目名 ⌄:移除项目;仓库链接)。项目是一块之后(gugu-dev#181),它住在项目块的页签条上,
 * ❌ 再另起一条顶栏。隐藏的内部项目(task-home)不是用户的项目,不出菜单(见 session-home-project-constants)。
 */
export const ProjectMenu = observer(function ProjectMenu({ projectId }: { projectId: string }) {
  const mounted = asMounted(getProjectStore(projectId))
  if (!mounted || isImplicitSessionHomeProject({ id: projectId })) return null
  return <MountedProjectTitlebarLeft projectId={projectId} />
})
