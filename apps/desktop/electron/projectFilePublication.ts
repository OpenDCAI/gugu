import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { FILE_CHUNK_BYTES, type FileRevision } from '@gugu/core/shared/fileResolver'
import { isInside, readWorkspaceChunk } from './session/main/core/files/workspace-transfer'
import { findProjectFileCopy, listProjectGroupIds, rememberProjectFile } from './sessionpage/sessionpage-project-groups'
import { importProjectFile } from './projectFileImport'
import { sanitizeRemoteFileName } from './remoteFileOpen'
import type { AttachmentsEndpoint, CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import { handOffNextVersion, NextVersionHandoffRefused } from '@gugu/core/cloud/fileVersionHandoff'
import type { FilesPlatform } from '../src/session/shared/extensions/app-files-core'

export type ProjectFileMessage = Omit<CommitArgs, 'staging_key'>
/** `data` carries the bytes of a selection that has no disk path (a clipboard paste); `path` is then empty. */
export type SelectedProjectFile = { name: string; path: string; size: number; contentType: string; data?: ArrayBuffer }
/** The file this publication is the next version of, and the version it started from (`file_device_publish`'s `p_expected`). */
export type ProjectFileNextVersion = { itemId: string; expectedVersion: number }
/** `handoff`: a member's copy handed to this host, published under their name and message. */
export type ProjectFilePublishOptions = { message?: ProjectFileMessage; next?: ProjectFileNextVersion; handoff?: string }
type Publisher = NonNullable<FilesPlatform['publishFile']>
type AppUpload = Parameters<Publisher>[1]
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
/** Publish actual bound-root files, importing explicit external selections; the ordinary uploader stays shared. */
export function createProjectFilePublisher(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>; root(id: string): Promise<string | null>
  rpc: Rpc; env?: NodeJS.ProcessEnv; endpoint?(): Promise<AttachmentsEndpoint>
}) {
  /**
   * A new file message or next version is handed to the machine that keeps the chat's files, which publishes it
   * as this actor's file and message. Null when the ordinary upload decides. A copy
   * of an older version throws `File revision conflict`; the host offline or not in time, `NextVersionHandoffRefused`.
   */
  const handOff = async (chatId: string, file: SelectedProjectFile, actor: string, next?: ProjectFileNextVersion, message?: ProjectFileMessage) => {
    if (!deps.endpoint) return null
    const policy = await deps.rpc('file_project_policy_for', { p_chat: chatId, p_as: actor }) as { proactive_upload: boolean } | null
    if (!policy || (!next && policy.proactive_upload)) return null
    const bytes = file.data ? new Uint8Array(file.data) : new Uint8Array(await readFile(file.path))
    const itemId = next?.itemId ?? randomUUID()
    const outcome = await handOffNextVersion(await deps.endpoint(), { itemId, ...(next ? { expectedVersion: next.expectedVersion } : { chatId }),
      fileName: file.name.split('/').at(-1)!, contentType: file.contentType, bytes, as: actor,
      ...(message ? { message: { message_id: message.message_id, caption: message.caption, to_user_ids: message.to_user_ids ?? [],
        reply_to_message_id: message.reply_to_message_id, thread_root_id: message.thread_root_id ?? null,
        is_thread_root: message.is_thread_root, via_app: message.via_app } } : {}) })
    if (outcome.status === 'conflict') throw new Error('File revision conflict')
    if (outcome.status !== 'published') throw new NextVersionHandoffRefused(outcome)
    const result = await deps.rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: actor })
    const row = (Array.isArray(result) ? result[0] : result) as NonNullable<Awaited<ReturnType<Publisher>>>
    return { ...row, message: { id: outcome.message_id, chat_id: chatId, file_item_id: itemId, file_version: outcome.version } }
  }
  const binding = async (chatId: string, actor: string) => {
    const identity = await deps.identity()
    const project = (await listProjectGroupIds(identity.accountId, deps.env)).find(row => row.chatId === chatId)
    if (!project) return null
    let policy = await deps.rpc('file_project_policy_for', { p_chat: chatId, p_as: actor }) as { host_device_id: string; host_project_id: string; proactive_upload: boolean } | null
    if (!policy) policy = await deps.rpc('file_project_policy_as', { p_chat: chatId, p_device: identity.deviceId, p_project: project.projectId, p_upload: false, p_temporary: true, p_retention: '7d' }) as NonNullable<typeof policy>
    if (policy.host_device_id !== identity.deviceId || policy.host_project_id !== project.projectId) throw new Error('Only the bound file host can publish project files')
    return { identity, project, policy }
  }
  const publishFile = async (chatId: string, file: SelectedProjectFile, parentId: string | null, actor: string,
    store?: Parameters<Publisher>[4], { message, next, handoff }: ProjectFilePublishOptions = {}, temporary = false): Promise<Awaited<ReturnType<Publisher>> & { message?: Record<string, unknown> } | null> => {
    let bound: Awaited<ReturnType<typeof binding>>
    try { bound = await binding(chatId, actor) } catch (error) {
      // This machine has the project, but another one keeps its files.
      if ((!next && (!message || parentId)) || handoff || !/Only the bound file host/.test(String(error))) throw error
      bound = null
    }
    // New handoffs here are root-level file messages; App folder creation keeps its existing publisher contract.
    if (!bound) return (next || (message && !parentId)) && !handoff ? handOff(chatId, file, actor, next, message) : null
    const { identity, project, policy } = bound
    if (policy.proactive_upload && !store && !handoff) return null
    const root = await deps.root(project.projectId)
    if (!root) throw new Error('Project root is unavailable')
    if (!isAbsolute(file.path)) throw new Error('Choose an original file in the bound project folder')
    if (temporary || !isInside(root, file.path)) file = { ...file,
      path: await importProjectFile(root, file, sha => findProjectFileCopy(project.projectId, sha, identity.accountId, identity.deviceId, deps.env)) }
    const path = relative(root, file.path).split(sep).join('/')
    const first = await readWorkspaceChunk(root, { path, offset: 0, length: 0 }), hash = createHash('sha256')
    if (first.size !== file.size) throw new Error('Choose the original file in the bound project folder')
    for (let offset = 0; offset < first.size; offset += FILE_CHUNK_BYTES) {
      const length = Math.min(FILE_CHUNK_BYTES, first.size - offset), part = await readWorkspaceChunk(root, { path, offset, length })
      const bytes = Buffer.from(part.data, 'base64')
      if (part.etag !== first.etag || bytes.length !== length) throw new Error('Project file changed during publication')
      hash.update(bytes)
    }
    const sha256 = hash.digest('hex')
    let row: NonNullable<Awaited<ReturnType<Publisher>>>, sent: Record<string, unknown> | undefined
    if (policy.proactive_upload && !handoff) row = await store!()
    else {
      const receipt = await (handoff
        ? deps.rpc('file_version_handoff_publish', { p_id: handoff, p_path: path, p_sha: sha256, p_size: first.size })
        : deps.rpc('file_device_publish', { p_item: next?.itemId ?? randomUUID(), p_chat: chatId, p_device: identity.deviceId, p_path: path, p_sha: sha256,
          p_size: first.size, p_filename: file.name.split('/').at(-1), p_type: file.contentType, p_parent: parentId,
          ...(next ? { p_expected: next.expectedVersion } : {}), ...(message ? { p_message: message } : {}) })) as { status?: string; item_id: string; message?: Record<string, unknown> }
      // A handoff the requester withdrew, or that the file moved on from, is settled without a version.
      if (handoff && receipt.status !== 'published') throw new Error(`Next version handoff ${receipt.status}`)
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
  /**
   * A pasted file, or an App's upload (its bytes, no path — an agent's new text, the next version it wrote), has no
   * original to point at: park its bytes in a private temp file and import that like any external selection. Never read
   * as a project path named by its title.
   */
  const publish = async (chatId: string, upload: AppUpload | SelectedProjectFile, parentId: string | null, actor: string,
    store?: Parameters<Publisher>[4], options: ProjectFilePublishOptions = {}) => {
    const file: SelectedProjectFile = 'bytes' in upload
      ? { name: upload.name, path: '', size: upload.bytes.byteLength, contentType: upload.contentType, data: upload.bytes }
      : upload
    if (!file.data) return publishFile(chatId, file, parentId, actor, store, options)
    if (file.path || file.data.byteLength !== file.size) throw new Error('Pasted file does not match its bytes')
    const directory = await mkdtemp(join(tmpdir(), 'gugu-pasted-')), { data, ...selected } = file
    try {
      const path = join(directory, sanitizeRemoteFileName(file.name))
      await writeFile(path, new Uint8Array(data), { mode: 0o600 })
      // `temporary`: the temp copy is always imported, even when a bound root happens to contain the temp directory.
      return await publishFile(chatId, { ...selected, path }, parentId, actor, store, options, true)
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) } // the message is already committed: a stuck temp file must not turn it into an error
  }
  return Object.assign(publish, { async local(chatId: string, actor: string) { const bound = await binding(chatId, actor); return !!bound && !bound.policy.proactive_upload } })
}
