import { copyVerifiedFile } from '@gugu/core/shared/fileCipher'
import { fileRefKey, requireFileRange, requireFileRevision, type FileBytes, type FileContext, type FileRef, type FileRevision } from '@gugu/core/shared/fileResolver'
import { readWorkspaceChunk } from './session/main/core/files/workspace-transfer'
import { readProjectFile } from './sessionpage/sessionpage-project-groups'
import { createFileSink } from './fileSnapshot'

export const PROJECT_FILE_READ = 'file.read'
type ReadRequest = { ref: FileRef; offset: number; length: number; etag?: string }
export type ProjectFileChunk = { revision: FileRevision; offset: number; etag: string; data: string }
export type ProjectFileReader = (request: ReadRequest) => Promise<ProjectFileChunk>

/** The host chooses the path from its own index. No reader path or write operation is accepted. */
export function createProjectFileReader(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>
  root(projectId: string): Promise<string | null>
  env?: NodeJS.ProcessEnv
}) {
  return async (request: ReadRequest, callerId: string): Promise<ProjectFileChunk> => {
    if (!request || Object.keys(request).some(key => !['ref', 'offset', 'length', 'etag'].includes(key))) throw new Error('Invalid file read request')
    fileRefKey(request.ref)
    const identity = await deps.identity()
    if (identity.accountId !== callerId) throw new Error('File reader is not the device owner')
    const revision = await readProjectFile(request.ref, identity.accountId, identity.deviceId, deps.env)
    if (!revision) throw new Error('Local file revision is unavailable')
    requireFileRange(revision.size_bytes, request.offset, request.length)
    const root = await deps.root(revision.host_project_id!)
    if (!root) throw new Error('Project root is unavailable')
    const chunk = await readWorkspaceChunk(root, { path: revision.relative_path!, offset: request.offset, length: request.length })
    if (chunk.size !== revision.size_bytes || request.etag !== undefined && request.etag !== chunk.etag) throw new Error('Local file changed during read')
    if (JSON.stringify(await deps.identity()) !== JSON.stringify(identity) || !await readProjectFile(request.ref, identity.accountId, identity.deviceId, deps.env)) throw new Error('File binding changed during read')
    // Absolute host paths stay here. The current etag anchors this read, not the publication mtime.
    return { revision, offset: chunk.offset, etag: chunk.etag, data: chunk.data }
  }
}

/** Local and SSH both feed the same full SHA verification before any bytes are exposed. */
export async function openProjectFileSource(revision: FileRevision, read: ProjectFileReader): Promise<FileBytes> {
  requireFileRevision(revision)
  const ref = { item_id: revision.item_id!, version: revision.version! }
  const first = await read({ ref, offset: 0, length: 0 })
  const identity = (value: FileRevision) => JSON.stringify([value.item_id, value.version, value.chat_id, value.host_account_id, value.host_device_id, value.host_project_id, value.relative_path, value.sha256, value.size_bytes])
  const check = (chunk: ProjectFileChunk, offset: number, length: number) => {
    requireFileRevision(chunk.revision)
    const bytes = Buffer.from(chunk.data, 'base64')
    if (!first.etag || chunk.etag !== first.etag || chunk.offset !== offset || identity(chunk.revision) !== identity(revision) ||
      bytes.length !== length || bytes.toString('base64') !== chunk.data) throw new Error('Invalid project file chunk')
    return new Uint8Array(bytes)
  }
  check(first, 0, 0)
  return { size: revision.size_bytes, dispose: async () => {}, async read(offset, length) {
    requireFileRange(revision.size_bytes, offset, length)
    return check(await read({ ref, offset, length, etag: first.etag }), offset, length)
  } }
}

export async function snapshotProjectFile(revision: FileRevision, read: ProjectFileReader, tempRoot: string, signal?: AbortSignal): Promise<FileBytes> {
  return copyVerifiedFile(revision, await openProjectFileSource(revision, read), await createFileSink(tempRoot, revision.size_bytes), signal)
}

/** Called before metadata lookup. Agents require their existing authorization context instead. */
export function localProjectFileProvider(deps: {
  identity(): Promise<{ accountId: string; deviceId: string }>
  read: ReturnType<typeof createProjectFileReader>; tempRoot: string; env?: NodeJS.ProcessEnv
}) {
  return async (context: FileContext) => {
    const identity = await deps.identity()
    if (context.actor.actorId !== identity.accountId || context.actor.accountId !== identity.accountId) return null
    const revision = await readProjectFile(context.ref, identity.accountId, identity.deviceId, deps.env)
    return revision ? { revision, open: () => snapshotProjectFile(revision, request => deps.read(request, context.actor.actorId), deps.tempRoot, context.signal) } : null
  }
}
