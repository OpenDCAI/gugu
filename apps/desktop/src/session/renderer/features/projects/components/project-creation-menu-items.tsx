import { FolderOpen, Plus } from '@/lib/icons'
import { createProjectFromLocalFolder } from '@renderer/features/projects/components/create-project-from-local-folder'
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store'
import { rpc } from '@renderer/lib/ipc'
import { useShowModal } from '@renderer/lib/modal/modal-provider'
import { DropdownMenuItem } from '@renderer/lib/ui/dropdown-menu'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { log } from '@renderer/utils/logger'
import { isWebTarget } from '@/lib/target'

/** #6264 在别的机器上建:空白项目建在那台机器的默认项目目录下,「使用现有文件夹」浏览那台机器(照 VS Code Remote「Open Folder」)。 */
export type ProjectCreationMachine = {
  deviceId: string
  label: string
  /** 浏览那台机器的文件夹从哪开始。 */
  browseFrom: string
}

export function ProjectCreationMenuItems({
  onProjectReady,
  machine = null,
  disabled = false
}: {
  onProjectReady?: (projectId: string) => void
  /** null = 本机。 */
  machine?: ProjectCreationMachine | null
  disabled?: boolean
}) {
  const { translate } = useSessionMessages()
  const showCreateProjectNameModal = useShowModal('createProjectNameModal')
  const showLocalFolderProjectModal = useShowModal('localFolderProjectModal')

  const handleExistingFolder = async () => {
    if (machine) {
      // 那台机器上的目录选择器由宿主画(与侧栏、新建框「浏览那台机器」同一个),选中后在那台机器上加成项目。
      const path = await remoteHostsStore.pickFolder(machine.deviceId, machine.browseFrom)
      if (!path) return
      onProjectReady?.(await remoteHostsStore.ensureProject(machine.deviceId, path))
      return
    }
    // @@@task-web-host — 网页版没有系统文件夹对话框(无头宿主里只会静默取消,owner 实测「点了没反应」)
    // → 开咕咕自己的小弹窗:应用内目录浏览器 + 零命名。❌ 不接旧的 AddProjectModal。
    if (isWebTarget) {
      showLocalFolderProjectModal({ onSuccess: (projectId) => onProjectReady?.(projectId) })
      return
    }
    const path = await rpc.app.openSelectDirectoryDialog({
      title: translate('projects.create.pickFolderTitle'),
      message: translate('projects.create.pickFolderMessage')
    })
    if (!path) return
    const projectId = await createProjectFromLocalFolder(path, translate)
    if (projectId) onProjectReady?.(projectId)
  }

  return (
    <>
      <DropdownMenuItem
        disabled={disabled}
        data-testid="project-create-blank"
        onClick={() =>
          showCreateProjectNameModal({
            machine: machine ? { deviceId: machine.deviceId, label: machine.label } : null,
            onSuccess: (projectId) => onProjectReady?.(projectId)
          })
        }
      >
        <Plus className="size-3.5" />
        <span>{translate('projects.create.blankProject')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={disabled}
        data-testid="project-create-existing"
        onClick={() =>
          void handleExistingFolder().catch((error: unknown) =>
            log.error('[projects] 用现有文件夹建项目失败', { machine: machine?.deviceId ?? null, error })
          )
        }
      >
        <FolderOpen className="size-3.5" />
        <span>{translate('projects.create.existingFolder')}</span>
      </DropdownMenuItem>
    </>
  )
}
