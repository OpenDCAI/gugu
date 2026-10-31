import { Globe, Trash2 } from '@/lib/icons'
import { GithubIcon } from '@/lib/icons'
import { observer } from 'mobx-react-lite'
import type { ReactNode } from 'react'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@renderer/lib/ui/context-menu'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { ChatTabMenuItems, chatTabHasActions } from '@renderer/features/chats/chat-tab-menu-items'
import { OpenInMenuItems, useOpenInTargets } from '@renderer/lib/components/titlebar/open-in-menu'
import { isGitHubDotComHost, parseRepositoryRef } from '@shared/repository-ref'

const MountedProjectMenuItems = observer(function MountedProjectMenuItems({
  projectId,
  chatId
}: {
  projectId: string
  chatId: string | null
}) {
  const { navigate } = useNavigate()
  const { translate } = useSessionMessages()
  const path = asMounted(getProjectStore(projectId))?.data.path ?? null
  const displayName = projectDisplayName(getProjectStore(projectId)) ?? translate('projects.fallbackName')
  const confirmDeleteProject = useConfirmDeleteProject()
  const openIn = useOpenInTargets(path ?? '')

  const repo = getGitRepositoryStore(projectId)
  const remoteUrl = repo?.baseRemote?.url
  const repository = parseRepositoryRef(repo?.canonicalRepositoryUrl)
  const isGithubUrl = repository ? isGitHubDotComHost(repository.host) : false
  const repoLabel = repository?.nameWithOwner ?? remoteUrl?.replace(/^https?:\/\//, '')

  return (
    <>
        {chatId && chatTabHasActions(chatId) ? (
          <>
            <ChatTabMenuItems chatId={chatId} />
            <ContextMenuSeparator />
          </>
        ) : null}
        {path ? <OpenInMenuItems targets={openIn} /> : null}
        {remoteUrl && (
          <>
            {path ? <ContextMenuSeparator /> : null}
            <ContextMenuItem
              className="flex items-center gap-2"
              onClick={() => void rpc.app.openExternal(isGithubUrl ? (repository?.repositoryUrl ?? remoteUrl) : remoteUrl)}
            >
              {isGithubUrl ? <GithubIcon className="size-4" /> : <Globe className="size-4" />}
              <span className="truncate">{repoLabel}</span>
            </ContextMenuItem>
          </>
        )}
        {path || remoteUrl ? <ContextMenuSeparator /> : null}
        <ContextMenuItem
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
        </ContextMenuItem>
    </>
  )
})

/**
 * 项目页签的右键菜单(gugu-dev#181:页签条右端只留搜索、群文件夹、成员、历史,和原型一样):项目群的
 * 在本群打开 App,在哪里打开,仓库链接,移除项目。这枚页签只有这一个右键菜单,项目和它的群的东西都加在这里。
 * 隐藏的内部项目(task-home)不是用户的项目,不出菜单(见 session-home-project-constants)。
 */
export const ProjectTabMenu = observer(function ProjectTabMenu({ projectId, chatId, children }: { projectId: string; chatId: string | null; children: ReactNode }) {
  if (!projectHasMenu(projectId)) return <>{children}</>
  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-full w-full min-w-0">{children}</ContextMenuTrigger>
      <ContextMenuContent finalFocus={false} className="min-w-40">
        <MountedProjectMenuItems projectId={projectId} chatId={chatId} />
      </ContextMenuContent>
    </ContextMenu>
  )
})

export const projectHasMenu = (projectId: string) => !!asMounted(getProjectStore(projectId)) && !isImplicitSessionHomeProject({ id: projectId })

/** The same menu's items, for a strip whose project tab is the project's group (the chat's own tab carries the menu). */
export const ProjectMenuItems = observer(function ProjectMenuItems({ projectId, chatId }: { projectId: string; chatId: string }) {
  return projectHasMenu(projectId) ? <MountedProjectMenuItems projectId={projectId} chatId={chatId} /> : <ChatTabMenuItems chatId={chatId} />
})
