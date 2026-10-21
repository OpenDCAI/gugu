import { FolderPlus, ListFilter } from '@/lib/icons'
import { observer } from 'mobx-react-lite'
import { ProjectCreationMenuItems } from '@renderer/features/projects/components/project-creation-menu-items'
import { useNavigate } from '@renderer/lib/layout/navigation-provider'
import { RemoteProjectMenuItems } from './remote-project-menu-items'
import { sidebarStore } from '@renderer/lib/stores/app-state'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@renderer/lib/ui/dropdown-menu'
import { BoundShortcut } from '@renderer/lib/ui/shortcut'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { sidebarGroupHeaderClass, sidebarHeaderIconButtonClass } from './sidebar-primitives'
import { SidebarGroupToggle } from './sidebar-group-toggle'

export const ProjectsGroupLabel = observer(function ProjectsGroupLabel() {
  const { navigate } = useNavigate()
  const { translate } = useSessionMessages()

  return (
    <div className={sidebarGroupHeaderClass}>
      <SidebarGroupToggle
        label={translate('sidebar.projects')}
        count={sidebarStore.projectCount}
        collapsed={sidebarStore.projectsCollapsed}
        onToggle={() => sidebarStore.toggleProjectsCollapsed()}
        ariaLabel={
          sidebarStore.projectsCollapsed
            ? translate('sidebar.expandProjects')
            : translate('sidebar.collapseProjects')
        }
      />
      <div className="flex items-center gap-1">
        <DropdownMenu>
          <Tooltip>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={translate('sidebar.sortProjects')}
                      className={sidebarHeaderIconButtonClass}
                    >
                      <ListFilter />
                    </button>
                  }
                />
              }
            />
            <TooltipContent>{translate('sidebar.sortBy')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent className="min-w-48">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{translate('sidebar.sortBy')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={sidebarStore.sessionSortBy}>
                <DropdownMenuRadioItem
                  value="created-at"
                  onClick={() => sidebarStore.applySort('created-at')}
                >
                  {translate('sidebar.createdAt')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem
                  value="updated-at"
                  onClick={() => sidebarStore.applySort('updated-at')}
                >
                  {translate('sidebar.recentlyUsed')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <Tooltip>
            <DropdownMenuTrigger
              render={
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={translate('sidebar.addProject')}
                      className={sidebarHeaderIconButtonClass}
                    >
                      <FolderPlus />
                    </button>
                  }
                />
              }
            />
            <TooltipContent>
              {translate('sidebar.addProject')}
              <BoundShortcut settingsKey="newProject" variant="keycaps" />
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="min-w-60">
            <DropdownMenuGroup>
              <ProjectCreationMenuItems
                onProjectReady={(projectId) => navigate('project', { projectId })}
              />
              <RemoteProjectMenuItems />
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
})
