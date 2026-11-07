import { requireAgentFileAccess } from '@gugu/core/local/state/agentFileBoundary'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { inferDroppedBlobExtension, normalizeDroppedImageBytes } from './session/main/core/pty/persist-dropped-blob'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { DEVICE_STORE, FILE_CHUNK_BYTES, type FileRevision } from '@gugu/core/shared/fileResolver'
import { isInside, readWorkspaceChunk } from './session/main/core/files/workspace-transfer'
import { findProjectFileCopy, listProjectGroupIds, rememberProjectFile } from './sessionpage/sessionpage-project-groups'
import { importProjectFile } from './projectFileImport'
import { sanitizeRemoteFileName } from './remoteFileOpen'
import type { CommitArgs } from '@gugu/core/cloud/attachmentsApi'
import type { FileStorage } from '@gugu/core/shared/fileStorage'
import type { FilesPlatform } from '../src/session/shared/extensions/app-files-core'

export type ProjectFileMessage = Omit<CommitArgs, 'staging_key'>
/** `data` carries the bytes of a selection that has no disk path (a clipboard paste); `path` is then empty. */
export type SelectedProjectFile = { name: string; path: string; size: number; contentType: string; data?: ArrayBuffer }
/** The file this publication is the next version of, and the version it started from (`file_device_publish`'s `p_expected`). */
export type ProjectFileNextVersion = { itemId: string; expectedVersion: number }
/**
 * `task`: a task's input attachment (the agent's DM folder). It stays on this device whatever the chat and the account's
 * upload setting (owner 10-31: a desktop task's attachments are fetched on demand); the agent works on `path`, never on
 * the version kept here. `itemId`: the id a new file takes, chosen by the sender beforehand (a new task's first turn
 * names its files before the agent's DM exists).
 */
export type ProjectFilePublishOptions = { message?: ProjectFileMessage; next?: ProjectFileNextVersion; task?: boolean; itemId?: string }
type Publisher = NonNullable<FilesPlatform['publishFile']>
type AppUpload = Parameters<Publisher>[1]
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>
export type KeepableImage = { item_id: string; version: number; chat_id: string; file_name: string; content_type: string; sha256: string; size_bytes: number }
/**
 * A project chat has no host: what this device sends into it stays on this device — in a project it binds to the chat, or
 * in its device store — and every member's device may send the next version of any file, which it then keeps. Whether
 * a file stays here or is uploaded is this account's own setting. The ordinary uploader stays shared.
 */
export function createProjectFilePublisher(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>; root(id: string): Promise<string | null>
  rpc: Rpc; env?: NodeJS.ProcessEnv
  /** This account's own file storage setting. */
  storage(): Promise<FileStorage>
  /** Whether a device of this account binds the chat to a project: what makes it a project chat here. */
  projectChat(chatId: string): Promise<boolean>
}) {
  const readItem = async (itemId: string, actor: string) => {
    const result = await deps.rpc('workspace_get_as', { p_item_id: itemId, p_as_user_id: actor })
    const row = (Array.isArray(result) ? result[0] : result) as NonNullable<Awaited<ReturnType<Publisher>>>
    if (!row) throw new Error('File publication account changed')
    return row
  }
  const localRevision = (row: NonNullable<Awaited<ReturnType<Publisher>>>, size: number, sha256: string, identity: { accountId: string; deviceId: string }, projectId: string, path: string): FileRevision => ({ source: 'local', item_id: row.id, version: row.version, chat_id: row.chat_id, file_name: row.filename,
      content_type: row.content_type, size_bytes: size, sha256, host_account_id: identity.accountId, host_device_id: identity.deviceId, host_project_id: projectId, relative_path: path,
      workspace: { path: row.path, parent_id: row.parent_id, created_at: row.created_at, updated_at: row.updated_at, created_by: row.created_by, source_message_ids: row.source_message_ids ?? [] } })
  const digestInRoot = async (root: string, path: string) => {
    const first = await readWorkspaceChunk(root, { path, offset: 0, length: 0 }), hash = createHash('sha256')
    for (let offset = 0; offset < first.size; offset += FILE_CHUNK_BYTES) {
      const length = Math.min(FILE_CHUNK_BYTES, first.size - offset), part = await readWorkspaceChunk(root, { path, offset, length })
      const bytes = Buffer.from(part.data, 'base64')
      if (part.etag !== first.etag || bytes.length !== length) throw new Error('Project file changed during publication')
      hash.update(bytes)
    }
    return { size: first.size, sha256: hash.digest('hex') }
  }
  /** Null: not a project chat, so the ordinary upload decides. */
  const place = async (chatId: string, task = false) => {
    const identity = await deps.identity()
    if (task) return { identity, projectId: DEVICE_STORE, storage: null }
    const bound = (await listProjectGroupIds(identity.accountId, deps.env)).find(row => row.chatId === chatId)
    if (!bound && !await deps.projectChat(chatId)) return null
    return { identity, projectId: bound?.projectId ?? DEVICE_STORE, storage: await deps.storage() }
  }
  const publishFile = async (chatId: string, file: SelectedProjectFile, parentId: string | null, actor: string,
    store?: Parameters<Publisher>[4], { message, next, task, itemId }: ProjectFilePublishOptions = {}, temporary = false): Promise<Awaited<ReturnType<Publisher>> & { message?: Record<string, unknown>; path?: string } | null> => {
    const here = await place(chatId, task)
    if (!here) return null
    if (here.storage?.proactive_upload) return store ? store() : null
    const handed = file.path
    const { identity, projectId } = here
    const root = await deps.root(projectId)
    if (!root) throw new Error('Project root is unavailable')
    if (!isAbsolute(file.path)) throw new Error('Choose an original file on this computer')
    if (temporary || !isInside(root, file.path)) file = { ...file,
      path: await importProjectFile(root, file, sha => findProjectFileCopy(projectId, sha, identity.accountId, identity.deviceId, deps.env)) }
    const path = relative(root, file.path).split(sep).join('/')
    const { size, sha256 } = await digestInRoot(root, path)
    if (size !== file.size) throw new Error('Selected file changed before it was sent')
    const receipt = await deps.rpc('file_device_publish', { p_item: next?.itemId ?? itemId ?? randomUUID(), p_chat: chatId, p_device: identity.deviceId,
      p_project: projectId, p_path: path, p_sha: sha256, p_size: size, p_filename: file.name.split('/').at(-1), p_type: file.contentType, p_parent: parentId,
      ...(next ? { p_expected: next.expectedVersion } : {}), ...(message ? { p_message: message } : {}) }) as { item_id: string; message?: Record<string, unknown> }
    const sent = receipt.message
    if (message && !sent) throw new Error('Project attachment was not committed')
    const row = await readItem(receipt.item_id, actor)
    if (JSON.stringify(await deps.identity()) !== JSON.stringify(identity)) throw new Error('File publication account changed')
    await rememberProjectFile(localRevision(row, size, sha256, identity, projectId, path), identity.accountId, deps.env)
    const published = sent ? { ...row, message: sent } : row
    return task ? { ...published, path: handed } : published
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
    const { data, ...selected } = file, bytes = new Uint8Array(data)
    const directory = await mkdtemp(join(tmpdir(), 'gugu-pasted-'))
    try {
      const path = await requireAgentFileAccess(join(directory, sanitizeRemoteFileName(file.name)))
      await writeFile(path, bytes, { mode: 0o600 })
      // `temporary`: the temp copy is always imported, even when a bound root happens to contain the temp directory.
      return await publishFile(chatId, { ...selected, path }, parentId, actor, store, options, true)
    } finally { await rm(directory, { recursive: true, force: true }).catch(() => undefined) } // the message is already committed: a stuck temp file must not turn it into an error
  }
  /**
   * An image sent into a project chat is uploaded and expires; the machine that sent it (for an agent, the machine it runs
   * on) keeps its bytes too, so it still opens from there afterwards. `fetchCopy` reads the cloud copy, which is one path for
   * what was just sent, what a phone sent and what was sent before this existed. Rows that fail stay pending for the next drain.
   */
  const keepSent = async (fetchCopy: (row: KeepableImage) => Promise<{ path: string; dispose(): Promise<void> }>) => {
    const identity = await deps.identity()
    const groups = await listProjectGroupIds(identity.accountId, deps.env)
    // Each image once per drain: one that keeps failing must not stand in front of the rest, and it is tried again next drain.
    const seen = new Set<string>(), failed: string[] = []
    for (let rows: KeepableImage[]; (rows = await deps.rpc('file_device_adopt_pending', { p_device: identity.deviceId, p_skip: [...seen] }) as KeepableImage[]).length > 0;) {
      for (const image of rows) {
        seen.add(image.item_id)
        let copy: Awaited<ReturnType<typeof fetchCopy>> | undefined
        try {
          const projectId = groups.find(group => group.chatId === image.chat_id)?.projectId ?? DEVICE_STORE
          const root = await deps.root(projectId)
          if (!root) throw new Error('Project root is unavailable')
          copy = await fetchCopy(image)
          // Only a copy under .gugu/attachments: the backend accepts no other path for a kept image, and an agent's editable file there would not stay the same bytes.
          const kept = await importProjectFile(root, { path: copy.path, name: image.file_name, size: image.size_bytes }, async sha => {
            const found = await findProjectFileCopy(projectId, sha, identity.accountId, identity.deviceId, deps.env)
            return found?.relative_path?.startsWith('.gugu/attachments/') ? found : null
          })
          const path = relative(root, kept).split(sep).join('/')
          const { size, sha256 } = await digestInRoot(root, path)
          // The index first: a revision the database knows of must be one this machine can serve.
          await rememberProjectFile(localRevision(await readItem(image.item_id, identity.accountId), size, sha256, identity, projectId, path), identity.accountId, deps.env)
          await deps.rpc('file_device_adopt', { p_item: image.item_id, p_device: identity.deviceId, p_project: projectId, p_path: path, p_sha: sha256, p_size: size })
        } catch (error) { failed.push(`${image.item_id}: ${String(error)}`) } finally { await copy?.dispose().catch(() => undefined) }
      }
    }
    if (failed.length) throw new Error(`Sent images not kept on this machine, they stay pending: ${failed.join('; ')}`)
  }
  return Object.assign(publish, { keepSent, async local(chatId: string) { const here = await place(chatId); return !!here && !here.storage?.proactive_upload } })
}

/**
 * A task attachment that has no file of its own to hand the agent — a paste, or an image the agent cannot read as it is
 * (HEIC/HEIF, turned into PNG here as the old task-attachments path did) — written once, where agents' downloads land. It
 * is the agent's copy; the version kept in the DM folder is cloned from it when published (`importProjectFile`).
 */
export async function writeTaskCopy(directory: string, name: string, bytes: Uint8Array, mimeType?: string): Promise<{ path: string; name: string; size: number; mimeType?: string }> {
  const normalized = await normalizeDroppedImageBytes(bytes, { name, mimeType })
  const declared = inferDroppedBlobExtension(name, mimeType)
  const converted = !!normalized.ext && normalized.ext !== declared
  const named = converted ? `${name.replace(/\.[^.]+$/, '')}${normalized.ext}` : name
  const target = await requireAgentFileAccess(join(directory, randomUUID()))
  await mkdir(target, { recursive: true, mode: 0o700 })
  const path = await requireAgentFileAccess(join(target, sanitizeRemoteFileName(named)))
  await writeFile(path, normalized.bytes, { mode: 0o600 })
  return { path, name: named, size: normalized.bytes.byteLength, mimeType: converted ? 'image/png' : mimeType }
}
