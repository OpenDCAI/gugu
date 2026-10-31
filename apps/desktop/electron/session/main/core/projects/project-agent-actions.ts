import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project'
import { randomUUID } from 'node:crypto'
import type { AttachProjectFolderError, ProjectFolder } from '@shared/core/projects/project-folders'
import type { LocalProject } from '@shared/projects'
import { linkFolderOnMachine } from '@shared/core/projects/project-attach-flow'
import { sameFolder } from '@shared/core/projects/folder-path'

type Answer<T, E extends { type?: string; message?: string } = { type?: string; message?: string }> =
  | { success: true; data: T }
  | { success: false; error: E }
export type ProjectAgentAction =
  | { action: 'project_list' }
  | { action: 'project_create'; name: string; path: string }
  | { action: 'project_get'; project_id?: string }
  | { action: 'project_add_folder'; project_id?: string; path: string; merge_existing?: boolean; source_project_id?: string }
  | { action: 'project_remove_folder'; project_id?: string; folder_id: string }
  | { action: 'project_remove_device'; project_id?: string }
  | { action: 'project_restore_device'; project_id?: string; chat_id: string; expected_chat_id: string | null }
  | { action: 'project_prepare_device'; project_id?: string }
  | { action: 'project_bind_folder'; chat_id: string; name: string; path: string; merge_existing?: boolean }
  | { action: 'project_add_device'; project_id?: string; target_device: string; path: string; merge_existing?: boolean }

export interface ProjectAgentOps {
  list(): Promise<LocalProject[]>
  get(id: string): Promise<LocalProject | undefined>
  create(name: string, path: string, id?: string): Promise<Answer<LocalProject>>
  folders(id: string): Promise<Answer<ProjectFolder[]>>
  attach(id: string, path: string): Promise<Answer<ProjectFolder, AttachProjectFolderError>>
  detach(id: string, folderId: string): Promise<Answer<void>>
  bindings(): Promise<Answer<Array<{ projectId: string; chatId: string }>>>
  ensureGroup(id: string): Promise<Answer<{ chatId: string }>>
  bind(id: string, chatId: string, expectedChatId?: string | null): Promise<Answer<unknown>>
  unbind(id: string): Promise<Answer<{ expectedChatId: string | null }>>
  inspect(path: string): Promise<{ isDirectory: boolean; existingProject?: LocalProject }>
  sessionCount(id: string): Promise<number>
  delete(id: string): Promise<void>
}

function value<T, E extends { type?: string; message?: string }>(answer: Answer<T, E>): T {
  if (!answer.success) throw new Error(answer.error.message ?? answer.error.type ?? 'Project operation failed')
  return answer.data
}

async function localOps(): Promise<ProjectAgentOps> {
  const [{ getProjects, getProjectById }, { createProject, inspectProjectPath }, folders, groups, { deleteProject }, { db }, { sessions }, { eq, isNull, and }] = await Promise.all([
    import('./operations/getProjects'), import('./operations/createProject'), import('./operations/project-folders'), import('./operations/project-groups'), import('./operations/deleteProject'), import('@main/db/client'), import('@main/db/schema'), import('drizzle-orm'),
  ])
  return {
    list: getProjects, get: getProjectById,
    create: (name, path, id) => createProject({ id, type: 'local', name, path, allowNonGit: true, initGitRepository: false, createDirectory: false }),
    folders: folders.listProjectFolders, attach: folders.attachProjectFolder, detach: folders.detachProjectFolder,
    bindings: groups.listProjectGroupBindings, ensureGroup: groups.ensureProjectGroup, bind: groups.bindProjectToGroup, unbind: groups.unbindProjectGroupForAgent,
    inspect: (path) => inspectProjectPath({ type: 'local', path }), delete: deleteProject,
    sessionCount: async (id) => (await db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.projectId, id), isNull(sessions.archivedAt)))).length,
  }
}

const row = (project: LocalProject) => ({ project_id: project.id, name: project.name, path: project.path })
const notice = (chatId: string | undefined, text: string) => chatId ? { chat_id: chatId, text } : null

export async function runProjectAgentAction(context: { projectId?: string }, action: ProjectAgentAction, ops?: ProjectAgentOps): Promise<unknown> {
  const api = ops ?? await localOps()
  // #609 workspace(任务工作区、~、助理与 App 的目录)不是项目,不列。
  if (action.action === 'project_list') return (await api.list()).filter((project) => project.kind !== 'workspace' && !isImplicitSessionHomeProjectId(project.id)).map(row)
  if (action.action === 'project_create') {
    const project = value(await api.create(action.name, action.path))
    const chatId = value(await api.ensureGroup(project.id)).chatId
    return { ...row(project), chat_id: chatId, group_notice: notice(chatId, `创建了项目「${project.name}」，根目录是 ${project.path}。`) }
  }
  if (action.action === 'project_bind_folder') return bindFolder(action, api)
  if (action.action === 'project_add_device') throw new Error('project_add_device must be routed through the device host')
  const id = action.project_id ?? context.projectId
  if (!id) throw new Error('project_id is required when operating on another device')
  const project = await api.get(id)
  if (!project) throw new Error(`Project not found: ${id}`)
  if (action.action === 'project_prepare_device') return { ...row(project), chat_id: value(await api.ensureGroup(id)).chatId }
  const chatId = value(await api.bindings()).find((b) => b.projectId === id)?.chatId
  if (action.action === 'project_get') return { ...row(project), chat_id: chatId ?? null, folders: value(await api.folders(id)).map((f) => ({ folder_id: f.workspaceId, path: f.path, kind: f.kind, branch: f.branch, sessions: f.sessionIds.map((session_id) => ({ session_id })) })) }
  if (action.action === 'project_restore_device') {
    value(await api.bind(id, action.chat_id, action.expected_chat_id))
    return { ...row(project), restored: true, chat_id: action.chat_id, group_notice: notice(action.chat_id, `恢复了这台设备上的「${project.name}」与共享项目的关联。`), undo: { tool: 'project_remove_device', project_id: id } }
  }
  if (action.action === 'project_add_folder') {
    if (action.merge_existing || action.source_project_id) {
      if (!action.merge_existing || !action.source_project_id) {
        throw new Error('确认已有项目归并时，需要同时提供 merge_existing:true 和 source_project_id')
      }
      const inspection = await api.inspect(action.path)
      if (!inspection.isDirectory || inspection.existingProject?.id !== action.source_project_id ||
          !sameFolder(inspection.existingProject.path, action.path)) {
        throw new Error('这个目录的项目归属已经变化，请重新读取后确认')
      }
      return attachExistingProjectRoot(project, action, action.source_project_id, chatId, api)
    }
    const already = value(await api.folders(id)).find((folder) => sameFolder(folder.path, action.path))
    if (already) return { ...row(project), folder_id: already.workspaceId, path: already.path, already_attached: true }
    const attached = await api.attach(id, action.path)
    if (!attached.success && attached.error.type === 'is-project-root') {
      return attachExistingProjectRoot(project, action, attached.error.projectId, chatId, api)
    }
    const folder = value(attached)
    const group = chatId ?? value(await api.ensureGroup(id)).chatId
    return { ...row(project), folder_id: folder.workspaceId, path: folder.path, group_notice: notice(group, `把文件夹 ${folder.path} 挂进了项目「${project.name}」。`), undo: { tool: 'project_remove_folder', project_id: id, folder_id: folder.workspaceId } }
  }
  if (action.action === 'project_remove_folder') {
    const folder = value(await api.folders(id)).find((f) => f.workspaceId === action.folder_id)
    if (!folder) throw new Error(`Folder not found in project: ${action.folder_id}`)
    value(await api.detach(id, action.folder_id))
    return { ...row(project), detached: folder.path, group_notice: notice(chatId, `从项目「${project.name}」摘下了文件夹 ${folder.path}，文件和已有会话保留。`), undo: { tool: 'project_add_folder', project_id: id, path: folder.path } }
  }
  if (!chatId) return { ...row(project), unlinked: false, already_unlinked: true }
  const { expectedChatId } = value(await api.unbind(id))
  return { ...row(project), unlinked: true, group_notice: notice(chatId, `把这台设备上的「${project.name}」从共享项目中解除关联，文件和会话保留。`), undo: { tool: 'project_restore_device', project_id: id, chat_id: chatId, expected_chat_id: expectedChatId } }
}

async function attachExistingProjectRoot(
  target: LocalProject,
  action: Extract<ProjectAgentAction, { action: 'project_add_folder' }>,
  sourceId: string,
  targetChatId: string | undefined,
  api: ProjectAgentOps,
): Promise<unknown> {
  if (action.source_project_id && action.source_project_id !== sourceId) {
    throw new Error('这个目录所属的项目已经变化，请重新读取后确认')
  }
  const source = await api.get(sourceId)
  if (!source) throw new Error(`Project not found: ${sourceId}`)
  const sourceFolders = value(await api.folders(sourceId))
  const root = sourceFolders.find((folder) => folder.kind === 'root' && sameFolder(folder.path, action.path))
  if (!root) throw new Error('这个目录已不再是原项目的根目录，请重新读取项目')
  if (sourceId === target.id) return { ...row(target), folder_id: root.workspaceId, path: root.path, already_attached: true }

  const sourceChatId = value(await api.bindings()).find((binding) => binding.projectId === sourceId)?.chatId
  if (targetChatId && sourceChatId === targetChatId) {
    return { ...row(target), source_project_id: sourceId, folder_id: root.workspaceId, path: root.path, already_attached: true }
  }
  const sessions = await api.sessionCount(sourceId)
  if (sessions > 0 && !action.merge_existing) {
    return {
      ...row(target), needs_confirmation: true, source_project_id: sourceId, source_name: source.name,
      source_folders: sourceFolders.map((folder) => folder.path), sessions,
      message: `先征得 owner 同意：将项目「${source.name}」的 ${sourceFolders.length} 个目录和 ${sessions} 条会话接入「${target.name}」的项目群；文件、会话和原群历史保留。`,
    }
  }
  if (action.merge_existing && action.source_project_id !== sourceId) {
    throw new Error('merge_existing:true 需要带上确认结果中的 source_project_id')
  }
  const group = value(await api.ensureGroup(target.id)).chatId
  value(await api.bind(sourceId, group, sourceChatId ?? null))
  return {
    ...row(target), source_project_id: sourceId, folder_id: root.workspaceId, path: root.path,
    linked_project_id: sourceId,
    group_notice: notice(group, `把这台设备上的项目「${source.name}」及其 ${sourceFolders.length} 个目录接进了项目「${target.name}」，文件、会话和原群历史保留。`),
    undo: sourceChatId
      ? { tool: 'project_restore_device', project_id: sourceId, chat_id: sourceChatId, expected_chat_id: group }
      : { tool: 'project_remove_device', project_id: sourceId },
  }
}

async function bindFolder(action: Extract<ProjectAgentAction, { action: 'project_bind_folder' }>, api: ProjectAgentOps): Promise<unknown> {
  const bindings = value(await api.bindings())
  const member = bindings.find((b) => b.chatId === action.chat_id)
  if (member) {
    const already = value(await api.folders(member.projectId)).find((f) => sameFolder(f.path, action.path))
    if (already) return { project_id: member.projectId, folder_id: already.workspaceId, path: already.path, chat_id: action.chat_id, already_attached: true }
    const folder = value(await api.attach(member.projectId, action.path))
    return { project_id: member.projectId, folder_id: folder.workspaceId, path: folder.path, chat_id: action.chat_id, group_notice: notice(action.chat_id, `把这台设备上的 ${folder.path} 挂进了项目「${action.name}」。`), undo: { tool: 'project_remove_folder', project_id: member.projectId, folder_id: folder.workspaceId } }
  }
  const existing = (await api.inspect(action.path)).existingProject
  if (existing && !sameFolder(existing.path, action.path)) throw new Error(`Folder already belongs to project ${existing.name}`)
  const count = existing ? await api.sessionCount(existing.id) : 0
  if (existing && count > 0 && !action.merge_existing) return { needs_confirmation: true, project_id: existing.id, name: existing.name, sessions: count, message: 'This project has sessions. Ask the owner before merging its agents into the shared project group.' }
  const linked = await linkFolderOnMachine({
    ensureGroup: async () => ({ success: true, data: { chatId: action.chat_id } }),
    createProjectOn: async () => {
      const requestedId = randomUUID()
      const project = value(await api.create(action.name, action.path, requestedId))
      return { projectId: project.id, created: project.id === requestedId }
    },
    bind: (_machine, id, chatId) => api.bind(id, chatId), unbind: (_machine, id) => api.unbind(id), deleteProject: api.delete,
    sessionCountOf: api.sessionCount,
  }, { rowId: '', machine: null, path: action.path, existingProjectId: existing?.id })
  if (!linked.ok) throw linked.error
  return { project_id: linked.projectId, path: action.path, chat_id: action.chat_id, group_notice: notice(action.chat_id, `把这台设备上的 ${action.path} 接进了项目「${action.name}」。`), undo: { tool: 'project_remove_device', project_id: linked.projectId } }
}

export function isProjectAgentAction(action: { action: string }): action is ProjectAgentAction {
  return action.action.startsWith('project_')
}
