import type { Device } from '@gugu/core/shared/types/chat'
import { linkFolderOnMachine, planAttach, type LinkFolderDeps } from '@/session/shared/core/projects/project-attach-flow'
import { projectRpcOn } from '../partners/projectRpc'
import type { ChatTaskFolders } from './phoneTaskFolders'

/** 与桌面同一份归属、合并与撤销规则;选文件夹仍由 RemoteFolderPicker 问那台机器。 */
export async function attachPhoneProjectFolder(input: {
  project: ChatTaskFolders
  devices: readonly Device[]
  device: Device
  path: string
  confirmMerge: (name: string, count: number) => Promise<boolean>
}) {
  const { project, device, path } = input
  const rpc = projectRpcOn(device)
  const plan = await planAttach({
    machine: device.device_id, path, memberIds: project.memberIds,
    machineOf: (id) => project.homeOf(id)?.deviceId ?? null,
    inspect: () => rpc.projects.inspectProjectPath({ type: 'local', path }),
  })
  let merge = plan.kind === 'merge' ? { id: plan.projectId, name: plan.name } : null
  if (plan.kind === 'taken') throw new Error(`folder belongs to ${plan.projectName}`)
  if (plan.kind === 'member') {
    const result = await rpc.projects.attachProjectFolder(plan.memberId, path)
    if (result.success) return {
      folder: result.data,
      undo: async () => (await rpc.projects.detachProjectFolder(plan.memberId, result.data.workspaceId)).success,
    }
    if (result.error.type !== 'is-project-root' || project.memberIds.includes(result.error.projectId)) throw new Error(result.error.message)
    merge = { id: result.error.projectId, name: result.error.projectName }
  }
  if (merge) {
    const sessions = await rpc.sessions.getSessionsForProject(merge.id)
    if (sessions.length && !await input.confirmMerge(merge.name, sessions.length)) return null
  }
  const representative = input.devices.find((row) => row.device_id === project.homeOf(project.rowId)?.deviceId)
  if (!representative) throw new Error('project machine not found')
  const deps: LinkFolderDeps = {
    ensureGroup: (id) => projectRpcOn(representative).projects.ensureProjectGroup(id),
    createProjectOn: async () => {
      const result = await rpc.projects.createProject({ type: 'local', id: crypto.randomUUID(), path, name: project.name, createDirectory: false, allowNonGit: true })
      if (!result.success) throw new Error('message' in result.error ? result.error.message : result.error.type)
      return { projectId: result.data.id, created: true }
    },
    bind: (_, id, chatId) => rpc.projects.bindProjectToGroup(id, chatId),
    unbind: (_, id) => rpc.projects.unbindProjectGroup(id),
    deleteProject: (id) => rpc.projects.deleteProject(id),
    sessionCountOf: async (id) => (await rpc.sessions.getSessionsForProject(id)).length,
  }
  const linked = await linkFolderOnMachine(deps, { rowId: project.rowId, machine: device.device_id, path, existingProjectId: merge?.id })
  if (!linked.ok) throw linked.error
  const folders = await rpc.projects.listProjectFolders(linked.projectId)
  if (!folders.success) throw new Error(folders.error.message)
  const folder = folders.data.find((row) => row.path === path)
  if (!folder) throw new Error('attached folder not found on that machine')
  return { folder, undo: linked.undo }
}
