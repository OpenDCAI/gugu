/** #113 账号上记着的一台机器上的项目(见 cloud/deviceProjects.ts)。 */
export type DeviceProjectFolderKind = 'root' | 'attached'

/** 项目挂的一个文件夹(那台机器上的一个目录)。分支、在跑的会话是此刻的读数,不记在账号上。 */
export type DeviceProjectFolder = {
  /** 那台机器上这个文件夹的工作区记录 id(新建会话时的 workspaceId)。 */
  workspaceId: string
  kind: DeviceProjectFolderKind
  path: string
  /** 挂上的时间(ISO);根目录为 null。 */
  attachedAt: string | null
}

export type DeviceProject = {
  /** 那台机器上的本地项目 id。 */
  localProjectId: string
  name: string
  rootPath: string
  /** 项目在那台机器上建立的时间(ISO);侧栏按它排。 */
  createdAt: string
  /** 绑的项目群;还没绑 = null。 */
  chatId: string | null
  /** 根目录在前(摘除了根目录的项目没有这一项)。 */
  folders: DeviceProjectFolder[]
}
