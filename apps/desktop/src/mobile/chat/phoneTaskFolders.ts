import type { Device } from '@gugu/core/shared/types/chat'
import type { FolderCardMachine } from '@renderer/features/projects/components/main-panel/project-folder-card'
import type { ShownFolder } from '@renderer/features/projects/components/main-panel/project-folders'

/** 一张文件夹从哪台机器、哪个本地项目开工(手机派新任务时带给那台机器)。 */
export type TaskFolderHome = { deviceId: string; localProjectId: string; machine: FolderCardMachine }

export type ChatTaskFolders = {
  /** 代表这个项目的那一个本地项目(卡片的 projectId,封面颜色按它定)。 */
  rowId: string
  name: string
  /** 这个项目在各台机器上的本地项目(都绑着这个群)。 */
  memberIds: string[]
  folders: ShownFolder[]
  homeOf: (localProjectId: string) => TaskFolderHome | undefined
}

/**
 * 一个项目群在账号上记着的文件夹(#113 identity.device_projects,各台机器自己写):手机派新任务时浮出来的那张卡就列这些。
 * 项目记在账号上、不归哪台机器(spec mobile-session-view「新任务照电脑」)⇒ 绑着这个群的本地项目,哪台机器上的都算;
 * 那台机器离线,纸照列、标离线。没有一台绑着这个群 = 不是项目群,null。
 */
export function taskFoldersOfChat(devices: readonly Device[], chatId: string): ChatTaskFolders | null {
  const homes = new Map<string, TaskFolderHome>()
  const folders: ShownFolder[] = []
  let representative: { id: string; name: string; chosen: boolean } | null = null
  for (const device of devices) {
    for (const project of device.projects ?? []) {
      if (project.chatId !== chatId) continue
      const machine: FolderCardMachine = {
        id: device.device_id,
        label: device.label || device.hostname,
        online: device.is_online,
        kind: device.capabilities.host_kind === 'desktop' ? 'computer' : 'server',
      }
      homes.set(project.localProjectId, { deviceId: device.device_id, localProjectId: project.localProjectId, machine })
      // 机器自己标的「代表这个群的那一个」优先;都没标就取先读到的。
      if (!representative || (project.groupRepresentative && !representative.chosen)) {
        representative = { id: project.localProjectId, name: project.name, chosen: project.groupRepresentative }
      }
      for (const folder of project.folders) {
        folders.push({
          workspaceId: folder.workspaceId,
          projectId: project.localProjectId,
          kind: folder.kind,
          path: folder.path,
          branch: null,
          sessionIds: [],
          attachedAt: folder.attachedAt,
          offline: !device.is_online,
        })
      }
    }
  }
  if (!representative) return null
  return { rowId: representative.id, name: representative.name, memberIds: [...homes.keys()], folders, homeOf: (id) => homes.get(id) }
}
