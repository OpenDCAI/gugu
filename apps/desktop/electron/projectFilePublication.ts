import { createHash, randomUUID } from 'node:crypto'
import { FILE_CHUNK_BYTES, type FileRevision } from '@gugu/core/shared/fileResolver'
import { readWorkspaceChunk } from './session/main/core/files/workspace-transfer'
import { listProjectGroupIds, rememberProjectFile } from './sessionpage/sessionpage-project-groups'
import type { FilesPlatform } from '../src/session/shared/extensions/app-files-core'

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
/** Publish only an actual file in the bound root; the ordinary uploader is passed in, never reimplemented. */
export function createProjectFilePublisher(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>; root(id: string): Promise<string | null>
  rpc: Rpc; env?: NodeJS.ProcessEnv
}): NonNullable<FilesPlatform['publishFile']> {
  return async (chatId, file, parentId, actor, store) => {
    const identity = await deps.identity()
    const project = (await listProjectGroupIds(identity.accountId, deps.env)).find(row => row.chatId === chatId)
    if (!project) return null
    let policy = await deps.rpc('file_project_policy_for', { p_chat: chatId, p_as: actor }) as { host_device_id: string; host_project_id: string; proactive_upload: boolean } | null
    if (!policy) policy = await deps.rpc('file_project_policy_as', { p_chat: chatId, p_device: identity.deviceId, p_project: project.projectId, p_upload: false, p_temporary: true, p_retention: '7d' }) as NonNullable<typeof policy>
    if (policy.host_device_id !== identity.deviceId || policy.host_project_id !== project.projectId) throw new Error('Only the bound file host can publish project files')
    const root = await deps.root(project.projectId)
    if (!root) throw new Error('Project root is unavailable')
    const first = await readWorkspaceChunk(root, { path: file.name, offset: 0, length: 0 }), hash = createHash('sha256')
    if (first.size !== file.bytes.byteLength) throw new Error('Choose the original file in the bound project folder')
    for (let offset = 0; offset < first.size; offset += FILE_CHUNK_BYTES) {
      const length = Math.min(FILE_CHUNK_BYTES, first.size - offset), part = await readWorkspaceChunk(root, { path: file.name, offset, length })
      const bytes = Buffer.from(part.data, 'base64')
      if (part.etag !== first.etag || bytes.length !== length) throw new Error('Project file changed during publication')
      hash.update(bytes)
    }
    const sha256 = hash.digest('hex')
    if (sha256 !== createHash('sha256').update(new Uint8Array(file.bytes)).digest('hex')) throw new Error('Choose the original file in the bound project folder')
    let row: Awaited<ReturnType<Parameters<NonNullable<FilesPlatform['publishFile']>>[4]>>
    if (policy.proactive_upload) row = await store()
    else {
      const receipt = await deps.rpc('file_device_publish', { p_item: randomUUID(), p_chat: chatId, p_device: identity.deviceId, p_path: file.name, p_sha: sha256,
        p_size: first.size, p_filename: file.name.split('/').at(-1), p_type: file.contentType, p_parent: parentId }) as { item_id: string }
      const result = await deps.rpc('workspace_get_as', { p_item_id: receipt.item_id, p_as_user_id: actor })
      row = (Array.isArray(result) ? result[0] : result) as typeof row
    }
    if (!row || JSON.stringify(await deps.identity()) !== JSON.stringify(identity)) throw new Error('File publication account changed')
    const revision: FileRevision = { source: 'local', item_id: row.id, version: row.version, chat_id: row.chat_id, file_name: row.filename,
      content_type: row.content_type, size_bytes: first.size, sha256, host_account_id: identity.accountId, host_device_id: identity.deviceId, host_project_id: project.projectId, relative_path: file.name,
      workspace: { path: row.path, parent_id: row.parent_id, created_at: row.created_at, updated_at: row.updated_at, created_by: row.created_by, source_message_ids: row.source_message_ids ?? [] } }
    await rememberProjectFile(revision, identity.accountId, deps.env)
    return row
  }
}
