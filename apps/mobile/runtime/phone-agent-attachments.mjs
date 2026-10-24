import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FOLDER_FILES, REMOTE_WORKSPACE_CHUNK_BYTES } from '../../../packages/session-core/src/session-record/workspace-contract.ts'
import { resolveAttachmentMimeType } from '../../../packages/core/src/shared/imageMime.mjs'
import { stableId, uuid } from './phone-agent-store.mjs'

const methods = new Set(['sessionCreate.writeAttachmentChunk', 'sessionCreate.commitAttachmentUpload', 'sessionCreate.discardAttachmentUpload'])
const fail = (code, message) => Object.assign(new Error(message), { code })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const integer = (value) => Number.isSafeInteger(value) && value >= 0

function segmentsOf(value) {
  if (!Array.isArray(value) || !value.length || value.length > 64 || value.some((segment) => typeof segment !== 'string' || !segment || segment === '.' || segment === '..' || Buffer.byteLength(segment) > 255 || /[/\\]/.test(segment) || Array.from(segment).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw fail('bad_request', '附件路径无效')
  return [...value]
}

/** Native/RPC JSON serializes Uint8Array as either an array or a contiguous numeric-key object. */
function bytesOf(value) {
  if (value instanceof Uint8Array) {
    if (value.byteLength > REMOTE_WORKSPACE_CHUNK_BYTES) throw fail('too_large', '附件分块超过允许的大小')
    return Buffer.from(value)
  }
  const keys = value && typeof value === 'object' ? Object.keys(value) : []
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw fail('bad_request', '附件分块不是字节数组')
  const length = Array.isArray(value) ? value.length : keys.length
  if (length > REMOTE_WORKSPACE_CHUNK_BYTES) throw fail('too_large', '附件分块超过允许的大小')
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) throw fail('bad_request', '附件字节数组必须连续')
  const output = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) {
    if (!Number.isInteger(value[i]) || value[i] < 0 || value[i] > 255) throw fail('bad_request', '附件包含无效字节')
    output[i] = value[i]
  }
  return output
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if (await realpath(path) !== resolve(path)) throw fail('bad_request', '附件目录已改变，无法安全保存')
  return path
}

async function readBytes(handle, length, offset) {
  const bytes = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await handle.read(bytes, done, length - done, offset + done)
    if (!bytesRead) throw fail('attachment_incomplete', '附件尚未上传完整')
    done += bytesRead
  }
  return bytes
}

async function verifyFile(path, file) {
  if (file.received !== file.total) throw fail('attachment_incomplete', '附件尚未上传完整')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== file.total) throw fail('attachment_incomplete', '附件大小已改变')
    const digest = createHash('sha256')
    let offset = 0
    for (const chunk of file.chunks) {
      if (chunk.offset !== offset) throw fail('attachment_incomplete', '附件分块不连续')
      const bytes = await readBytes(handle, chunk.size, chunk.offset)
      if (hash(bytes) !== chunk.sha256) throw fail('invalid_attachment', '附件内容与上传分块不符')
      digest.update(bytes); offset += chunk.size
    }
    if (offset !== file.total) throw fail('attachment_incomplete', '附件分块没有覆盖完整文件')
    const sha256 = digest.digest('hex')
    if (file.sha256 && file.sha256 !== sha256) throw fail('invalid_attachment', '附件内容已变化')
    return sha256
  } finally { await handle.close() }
}

/** Owner/session-scoped implementation of the existing composer upload RPC. Bytes are never
 * admitted as chat messages, and only verified, committed files become registered artifacts. */
export function createPhoneAttachmentApi({ ownerId, store, findSession, verifyAgent, registerArtifact }) {
  uuid(ownerId, 'ownerId')
  if (store.state.ownerId !== ownerId) throw fail('wrong_owner', '附件存储不属于当前账号')
  const queues = new Map()
  let root
  const rootDirectory = () => (root ??= realpath(store.directory).then((directory) => privateDirectory(join(directory, 'task-attachments'))))
  const identifiers = (input) => {
    let sessionId
    try { sessionId = uuid(input?.sessionId, 'sessionId') } catch { throw fail('bad_request', '附件任务标识无效') }
    if (typeof input.uploadId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(input.uploadId)) throw fail('bad_request', '附件上传标识无效')
    return sessionId
  }
  const resolveAgent = async (input) => {
    if (store.state.ownerId !== ownerId) throw fail('wrong_owner', '附件存储账号已改变')
    const sessionId = identifiers(input)
    const agent = await findSession(sessionId)
    if (!agent || agent.sessionId !== sessionId || store.state.agents[agent.agentUserId]?.sessionId !== sessionId) throw fail('not_found', '找不到这条手机任务')
    uuid(agent.agentUserId, 'agentUserId')
    await verifyAgent(agent.agentUserId)
    return agent
  }
  const paths = async (sessionId, uploadId) => {
    const base = await rootDirectory()
    const directory = await privateDirectory(join(base, sessionId))
    const incoming = join(directory, '.incoming', uploadId)
    const committed = join(directory, 'committed', uploadId)
    return { incoming, committed }
  }
  const keyOf = (input) => stableId('phone-composer-attachment', ownerId, input.sessionId, input.uploadId)
  const uploads = () => (store.state.attachmentUploads ??= {})
  const known = (input, agent) => {
    const entry = uploads()[keyOf(input)]
    if (entry && (entry.ownerId !== ownerId || entry.sessionId !== agent.sessionId || entry.agentUserId !== agent.agentUserId || entry.uploadId !== input.uploadId)) throw fail('wrong_owner', '附件上传归属不符')
    return entry
  }
  const currentPath = async (input, entry) => {
    const where = await paths(input.sessionId, input.uploadId)
    if (entry.status === 'uploading') return where.incoming
    try { await stat(where.committed); return where.committed }
    catch (error) { if (error.code === 'ENOENT' && entry.status === 'committing') return where.incoming; throw error }
  }
  const write = async (input, agent) => {
    const segments = segmentsOf(input.segments)
    const bytes = bytesOf(input.data)
    if (!integer(input.offset) || !integer(input.total)) throw fail('bad_request', '附件偏移和大小必须是非负整数')
    if (input.total > MAX_ATTACHMENT_BYTES || input.offset + bytes.length > input.total) throw fail('too_large', '附件超过允许的大小')
    if (input.total > 0 && bytes.length === 0) throw fail('bad_request', '非空附件不能上传空分块')
    let entry = known(input, agent)
    if (!entry) entry = uploads()[keyOf(input)] = { ownerId, sessionId: agent.sessionId, agentUserId: agent.agentUserId, uploadId: input.uploadId, status: 'uploading', files: [] }
    let file = entry.files.find((item) => JSON.stringify(item.segments) === JSON.stringify(segments))
    if (!file) {
      if (entry.status !== 'uploading') throw fail('bad_request', '已提交的附件不能添加文件')
      if (input.offset !== 0) throw fail('offset_mismatch', '附件必须从第一块开始上传')
      if (entry.files.length >= MAX_ATTACHMENT_FOLDER_FILES) throw fail('too_many_files', '附件文件夹包含过多文件')
      if (entry.files.reduce((sum, item) => sum + item.total, 0) + input.total > MAX_ATTACHMENT_BYTES) throw fail('too_large', '附件文件夹超过允许的大小')
      file = { segments, total: input.total, received: 0, chunks: [] }
      entry.files.push(file)
      await store.save()
    }
    if (file.total !== input.total) throw fail('bad_request', '重试不能更改附件大小')
    const sha256 = hash(bytes)
    const prior = file.chunks.find((chunk) => chunk.offset === input.offset && chunk.size === bytes.length)
    const append = input.offset === file.received && entry.status === 'uploading' && !prior
    if (!append && (!prior || prior.sha256 !== sha256)) throw fail('offset_mismatch', '附件分块偏移或重试内容不符')
    const base = await currentPath(input, entry)
    const path = join(base, ...segments)
    await privateDirectory(dirname(path))
    let handle
    try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW) }
    catch (error) {
      if (error.code !== 'ENOENT' || !append || input.offset !== 0) throw error
      handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile()) throw fail('bad_request', '附件目标不是普通文件')
      if (!append || info.size > file.received) {
        // A retry may arrive after the bytes reached disk but before the journal save finished.
        if (info.size < input.offset + bytes.length || (append && info.size !== input.offset + bytes.length) || hash(await readBytes(handle, bytes.length, input.offset)) !== sha256) throw fail('invalid_attachment', '已上传附件内容不符')
      } else {
        if (info.size !== file.received) throw fail('attachment_incomplete', '附件上传记录与文件大小不符')
        let written = 0
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, input.offset + written)
          if (!result.bytesWritten) throw fail('persist_failed', '附件分块未能写入')
          written += result.bytesWritten
        }
        await handle.sync()
      }
    } finally { await handle.close() }
    if (append) {
      file.chunks.push({ offset: input.offset, size: bytes.length, sha256 })
      file.received = input.offset + bytes.length
      await store.save()
    }
    return { received: input.offset + bytes.length }
  }
  const commit = async (input, agent) => {
    segmentsOf([input.name])
    if (input.kind !== 'file' && input.kind !== 'folder') throw fail('bad_request', '附件种类无效')
    if (input.record === false) throw fail('bad_request', '手机附件需要先创建任务，再在该任务中上传')
    if (input.mimeType !== undefined && (typeof input.mimeType !== 'string' || input.mimeType.length > 255 || /[\r\n\0]/.test(input.mimeType))) throw fail('bad_request', '附件类型无效')
    const fingerprint = stableId('phone-attachment-commit', input.kind, input.name, input.mimeType ?? null)
    const entry = known(input, agent)
    if (!entry || !entry.files.length) throw fail('not_found', '这个附件尚未上传')
    if (entry.files.length > MAX_ATTACHMENT_FOLDER_FILES) throw fail('too_many_files', '附件文件夹包含过多文件')
    if (entry.files.some((file) => !integer(file.total) || file.total > MAX_ATTACHMENT_BYTES) || entry.files.reduce((sum, file) => sum + file.total, 0) > MAX_ATTACHMENT_BYTES) throw fail('too_large', '附件超过允许的大小')
    if (entry.fingerprint && entry.fingerprint !== fingerprint) throw fail('bad_request', '同一次上传不能更改附件名称或种类')
    if (entry.files.some((file) => file.segments[0] !== input.name || (input.kind === 'file' ? file.segments.length !== 1 || entry.files.length !== 1 : file.segments.length < 2))) throw fail('bad_request', '提交的附件与上传目录不符')
    let directory = await currentPath(input, entry)
    for (const file of entry.files) file.sha256 = await verifyFile(join(directory, ...file.segments), file)
    await verifyAgent(agent.agentUserId)
    if (entry.status === 'committed') return entry.result
    const where = await paths(input.sessionId, input.uploadId)
    if (directory === where.incoming) {
      entry.status = 'committing'; entry.fingerprint = fingerprint
      await store.save()
      await privateDirectory(dirname(where.committed))
      try { await rename(where.incoming, where.committed) }
      catch (error) {
        entry.status = 'uploading'
        await store.save()
        throw error
      }
      directory = where.committed
    }
    const priorIds = new Set(Object.keys(store.state.artifacts ?? {}))
    try {
      for (const file of entry.files) await registerArtifact({ store, agent, groups: [], file: { file_path: join(directory, ...file.segments), name: file.segments.at(-1), size: file.total, sha256: file.sha256, mime_type: input.kind === 'file' ? resolveAttachmentMimeType(input.name, input.mimeType) : resolveAttachmentMimeType(file.segments.at(-1)), permissionRequirements: [] } })
      const path = join(directory, input.name)
      entry.result = { id: keyOf(input), storedPath: path, mentionPath: path, name: input.name, mimeType: input.kind === 'folder' ? 'inode/directory' : resolveAttachmentMimeType(input.name, input.mimeType), size: entry.files.reduce((sum, file) => sum + file.total, 0), ...(input.kind === 'file' ? { sha256: entry.files[0].sha256 } : {}) }
      entry.status = 'committed'
      await store.save()
      return entry.result
    } catch (error) {
      entry.status = 'committing'; delete entry.result
      for (const [id, artifact] of Object.entries(store.state.artifacts ?? {})) if (!priorIds.has(id) && artifact.ownerId === ownerId && artifact.sessionId === agent.sessionId && entry.files.some((file) => artifact.file_path === join(directory, ...file.segments))) delete store.state.artifacts[id]
      await store.save()
      throw error
    }
  }
  const discard = async (input, agent) => {
    const entry = known(input, agent)
    if (entry?.status === 'committed') return
    const where = await paths(input.sessionId, input.uploadId)
    await rm(where.incoming, { recursive: true, force: true })
    if (entry?.status === 'committing') await rm(where.committed, { recursive: true, force: true })
    delete uploads()[keyOf(input)]
    await store.save()
  }
  return {
    async invoke(channel, args) {
      if (!methods.has(channel)) return null
      let input
      try {
        if (!Array.isArray(args) || args.length !== 1 || !args[0] || typeof args[0] !== 'object') throw fail('bad_request', '附件请求缺少参数')
        input = args[0]
        identifiers(input)
        const key = keyOf(input)
        const prior = queues.get(key) ?? Promise.resolve()
        const operation = prior.catch(() => undefined).then(async () => {
          const agent = await resolveAgent(input)
          if (channel === 'sessionCreate.writeAttachmentChunk') return write(input, agent)
          if (channel === 'sessionCreate.commitAttachmentUpload') return commit(input, agent)
          return discard(input, agent)
        })
        queues.set(key, operation)
        try { return { value: { success: true, data: await operation } } }
        finally { if (queues.get(key) === operation) queues.delete(key) }
      } catch (error) {
        return { value: { success: false, error: { type: error.code ?? 'persist_failed', message: error.message ?? String(error) } } }
      }
    },
  }
}
