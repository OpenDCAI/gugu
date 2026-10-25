import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { FILE_CHUNK_BYTES, type FileRevision } from '@gugu/core/shared/fileResolver'
import { readWorkspaceChunk } from './session/main/core/files/workspace-transfer'
import { listProjectGroupIds, rememberProjectFile } from './sessionpage/sessionpage-project-groups'
import type { CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import type { FilesPlatform } from '../src/session/shared/extensions/app-files-core'

export type ProjectFileMessage = Omit<CommitArgs, 'staging_key'>
export type SelectedProjectFile = { name: string; path: string; size: number; contentType: string }
type Publisher = NonNullable<FilesPlatform['publishFile']>
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
/** Publish only an actual file in the bound root; the ordinary uploader is passed in, never reimplemented. */
export function createProjectFilePublisher(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>; root(id: string): Promise<string | null>
  rpc: Rpc; env?: NodeJS.ProcessEnv
}) {
  const binding = async (chatId: string, actor: string) => {
    const identity = await deps.identity()
    const project = (await listProjectGroupIds(identity.accountId, deps.env)).find(row => row.chatId === chatId)
    if (!project) return null
    let policy = await deps.rpc('file_project_policy_for', { p_chat: chatId, p_as: actor }) as { host_device_id: string; host_project_id: string; proactive_upload: boolean } | null
    if (!policy) policy = await deps.rpc('file_project_policy_as', { p_chat: chatId, p_device: identity.deviceId, p_project: project.projectId, p_upload: false, p_temporary: true, p_retention: '7d' }) as NonNullable<typeof policy>
    if (policy.host_device_id !== identity.deviceId || policy.host_project_id !== project.projectId) throw new Error('Only the bound file host can publish project files')
    return { identity, project, policy }
  }
  const publish = async (chatId: string, file: Parameters<Publisher>[1] | SelectedProjectFile, parentId: string | null, actor: string,
    store?: Parameters<Publisher>[4], message?: ProjectFileMessage): Promise<Awaited<ReturnType<Publisher>> & { message?: Record<string, unknown> } | null> => {
    const bound = await binding(chatId, actor); if (!bound) return null
    const { identity, project, policy } = bound
    if (policy.proactive_upload && !store) return null
    const root = await deps.root(project.projectId)
    if (!root) throw new Error('Project root is unavailable')
    if ('path' in file && !isAbsolute(file.path)) throw new Error('Choose an original file in the bound project folder')
    const path = 'path' in file ? relative(root, file.path).split(sep).join('/') : file.name
    const first = await readWorkspaceChunk(root, { path, offset: 0, length: 0 }), hash = createHash('sha256')
    if (first.size !== ('bytes' in file ? file.bytes.byteLength : file.size)) throw new Error('Choose the original file in the bound project folder')
    for (let offset = 0; offset < first.size; offset += FILE_CHUNK_BYTES) {
      const length = Math.min(FILE_CHUNK_BYTES, first.size - offset), part = await readWorkspaceChunk(root, { path, offset, length })
      const bytes = Buffer.from(part.data, 'base64')
      if (part.etag !== first.etag || bytes.length !== length) throw new Error('Project file changed during publication')
      hash.update(bytes)
    }
    const sha256 = hash.digest('hex')
    if ('bytes' in file && sha256 !== createHash('sha256').update(new Uint8Array(file.bytes)).digest('hex')) throw new Error('Choose the original file in the bound project folder')
    let row: NonNullable<Awaited<ReturnType<Publisher>>>, sent: Record<string, unknown> | undefined
    if (policy.proactive_upload) row = await store!()
    else {
      const receipt = await deps.rpc('file_device_publish', { p_item: randomUUID(), p_chat: chatId, p_device: identity.deviceId, p_path: path, p_sha: sha256,
        p_size: first.size, p_filename: file.name.split('/').at(-1), p_type: file.contentType, p_parent: parentId, ...(message ? { p_message: message } : {}) }) as { item_id: string; message?: Record<string, unknown> }
      sent = receipt.message
      if (message && !sent) throw new Error('Project attachment was not committed')
      const result = await deps.rpc('workspace_get_as', { p_item_id: receipt.item_id, p_as_user_id: actor })
      row = (Array.isArray(result) ? result[0] : result) as typeof row
    }
    if (!row || JSON.stringify(await deps.identity()) !== JSON.stringify(identity)) throw new Error('File publication account changed')
    const revision: FileRevision = { source: 'local', item_id: row.id, version: row.version, chat_id: row.chat_id, file_name: row.filename,
      content_type: row.content_type, size_bytes: first.size, sha256, host_account_id: identity.accountId, host_device_id: identity.deviceId, host_project_id: project.projectId, relative_path: path,
      workspace: { path: row.path, parent_id: row.parent_id, created_at: row.created_at, updated_at: row.updated_at, created_by: row.created_by, source_message_ids: row.source_message_ids ?? [] } }
    await rememberProjectFile(revision, identity.accountId, deps.env)
    return sent ? { ...row, message: sent } : row
  }
  return Object.assign(publish, { async local(chatId: string, actor: string) { const bound = await binding(chatId, actor); return !!bound && !bound.policy.proactive_upload } })
}
