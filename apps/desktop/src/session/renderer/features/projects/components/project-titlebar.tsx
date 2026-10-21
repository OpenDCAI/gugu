import { ChevronDown, Ellipsis, ExternalLink, Globe, Trash2 } from '@/lib/icons'
import { GithubIcon } from 'lucide-react'
import { observer } from 'mobx-react-lite'
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project'
import { SessionTitlebar } from '@renderer/features/sessions/session-titlebar'
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants'
import {
  asMounted,
  getProjectStore,
  getGitRepositoryStore,
  projectDisplayName
} from '@renderer/features/projects/stores/project-selectors'
import { rpc } from '@renderer/lib/ipc'
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider'
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
 * 项目视图的顶栏 —— **只有一套**。
 *
 * 从前这里按子视图分三个岔:主页/会话页返回零高度浮层(SessionTitlebar),设置页返回一条真的 40px 横条
 * (Titlebar,自带项目名下拉与它独有的右槽),挂载中则返回一条什么都没有的横条。同一个项目里两套
 * chrome 实现,owner 实机原话:「这算是一个工作区,他应该得到统一,而不是这么分裂,一步一景」。
 *
 * 现在统一到浮层这一套:项目菜单挂左槽,右上角是 owner 定的三层
 * (项目级 · 会话级 │ 工作级),三个子视图完全一致。
 */
export const ProjectTitlebar = observer(function ProjectTitlebar() {
  const {
    params: { projectId }
  } = useParams('project')
  const mounted = asMounted(getProjectStore(projectId))
  // 隐藏的内部项目(task-home)不是用户的项目,左槽那个项目菜单同样不该出现 ——
  // 与 ProjectTitleActions 同一条判据,见 session-home-project-constants。
  const showProjectMenu = mounted && !isImplicitSessionHomeProject({ id: projectId })

  return (
    <SessionTitlebar
      leftSlot={showProjectMenu ? <MountedProjectTitlebarLeft projectId={projectId} /> : undefined}
    />
  )
})
