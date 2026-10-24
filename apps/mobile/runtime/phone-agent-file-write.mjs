import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, open, realpath, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { stableId, uuid } from './phone-agent-store.mjs'

export const PHONE_TEXT_OUTPUT_MAX_BYTES = 1024 * 1024
const fail = (code, message) => Object.assign(new Error(message), { code })
const mimeTypes = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.toml': 'application/toml', '.ini': 'text/plain', '.log': 'text/plain', '.ics': 'text/calendar' }
const uniqueProofs = (...sources) => [...new Map(sources.flatMap((source) => source ?? []).map((proof) => [JSON.stringify(proof), structuredClone(proof)])).values()]
const invalidFilenameCharacter = (character) => {
  const code = character.charCodeAt(0)
  return character === '/' || character === '\\' || character === ':' || code <= 31 || code >= 127 && code <= 159 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069
}
const invalidCallIdCharacter = (character) => { const code = character.charCodeAt(0); return code <= 31 || code === 127 }

function contentOf(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((name) => name !== 'file_name' && name !== 'text')) throw fail('invalid_args', '只接受 file_name 和 text，不能指定路径或覆盖方式')
  const name = args?.file_name
  if (typeof name !== 'string' || !name || name !== name.trim() || Buffer.byteLength(name, 'utf8') > 120 || name.startsWith('.') || Array.from(name).some(invalidFilenameCharacter) || !name.isWellFormed()) throw fail('invalid_args', 'file_name 必须是120字节以内的单个普通文件名，不能含路径、隐藏文件名或控制字符')
  const extension = extname(name).toLowerCase()
  const mime = extension ? mimeTypes[extension] : 'text/plain'
  if (!mime) throw fail('unsupported', '当前只能生成 UTF-8 文本报告，例如 .md、.txt、.csv、.json、.html；不会生成 PDF、Office 或其他二进制格式')
  if (typeof args.text !== 'string' || !args.text.isWellFormed() || args.text.includes('\0')) throw fail('invalid_args', 'text 必须是有效的 UTF-8 文本，不能包含空字节')
  if (Buffer.byteLength(args.text, 'utf8') > PHONE_TEXT_OUTPUT_MAX_BYTES) throw fail('too_large', '单个手机文本产物最多1 MiB，请缩小报告内容后再保存')
  const bytes = Buffer.from(args.text, 'utf8')
  return { name, mime, bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

async function outputDirectory(store, agent) {
  const base = await realpath(store.directory)
  const directories = [base]
  for (const part of ['outputs', uuid(agent.agentUserId, 'agentUserId'), uuid(agent.sessionId, 'sessionId')]) {
    const next = join(directories.at(-1), part)
    try { await mkdir(next, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
    directories.push(next)
    const info = await lstat(next)
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(next) !== next) throw fail('not_granted', '任务输出目录已改变，不能通过链接写入其他位置')
  }
  const directory = directories.at(-1)
  const expected = await lstat(directory)
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  const check = async () => {
    for (const path of directories) {
      const info = await lstat(path)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail('not_granted', '任务输出目录在保存期间改变，未交付文件')
    }
    const pinned = await handle.stat()
    const current = await lstat(directory)
    if (pinned.dev !== expected.dev || pinned.ino !== expected.ino || current.dev !== pinned.dev || current.ino !== pinned.ino) throw fail('not_granted', '任务输出目录在保存期间被替换，未交付文件')
  }
  try { await check() } catch (error) { await handle.close(); throw error }
  // Android's app-private filesystem is POSIX. Anchor writes to the opened directory so an
  // ancestor renamed during IO cannot redirect a leaf into an unrelated directory.
  const ioDirectory = process.platform === 'android' || process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : directory
  return { directory, ioDirectory, check, close: () => handle.close() }
}

async function verifyFile(path, expected, sync = false) {
  const file = await open(path, (sync ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== expected.bytes.length || before.nlink !== 1) throw fail('file_changed', '已有输出不完整或已改变，原文件已保留，不能覆盖或复用')
    const bytes = Buffer.alloc(expected.bytes.length + 1)
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    if (size !== expected.bytes.length || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || createHash('sha256').update(bytes.subarray(0, size)).digest('hex') !== expected.sha256) throw fail('file_changed', '同一工具调用的输出内容已改变，原文件已保留，未交付文件')
    if (sync) await file.sync()
  } finally { await file.close() }
}

/** Text-only report generation. There is no caller-supplied path, append mode or overwrite mode. */
export function phoneTextWriteTool({ agent, job, store, authorize, registerArtifact }) {
  const inflight = new Map()
  const write = async (callId, input, id, fingerprint, signal) => {
    const ownerId = uuid(store.state.ownerId, 'ownerId')
    if (agent.ownerId && agent.ownerId !== ownerId || job.agentUserId && job.agentUserId !== agent.agentUserId) throw fail('not_granted', '这项输出不属于当前主人和任务')
    store.state.outputWrites ??= {}
    let entry = store.state.outputWrites[id]
    const validateEntry = () => { if (entry && (entry.ownerId !== ownerId || entry.agentUserId !== agent.agentUserId || entry.sessionId !== agent.sessionId || entry.jobId !== job.id || entry.fingerprint !== fingerprint)) throw fail('invalid_args', '同一工具调用不能改名或改内容，请使用一次新的工具调用创建另一个产物') }
    validateEntry()
    const proof = () => ({ groups: [...new Set([...(entry?.groups ?? []), ...(job.usedGroups ?? [])])], permissionRequirements: uniqueProofs(entry?.permissionRequirements, job.permissionRequirements) })
    const check = async (bound = proof()) => { signal?.throwIfAborted(); await authorize(bound.groups, { sessionId: agent.sessionId, permissionRequirements: bound.permissionRequirements }); signal?.throwIfAborted(); return bound }
    await check()
    // Another instance can claim the same journal key while authorization is in flight.
    entry = store.state.outputWrites[id]
    validateEntry()
    // Claim the immutable request before any file is created. A failed save never starts IO.
    entry ??= store.state.outputWrites[id] = { id, ownerId, agentUserId: agent.agentUserId, sessionId: agent.sessionId, jobId: job.id, callId, fingerprint, name: input.name, sha256: input.sha256, size: input.bytes.length, status: 'preparing', ...proof() }
    await store.save()
    const output = await outputDirectory(store, agent)
    const name = `${id}-${input.name}`
    const path = join(output.directory, name)
    const ioPath = join(output.ioDirectory, name)
    const temporaryName = `.${randomUUID()}.incomplete`
    const temporary = join(output.ioDirectory, temporaryName)
    const canonicalTemporary = join(output.directory, temporaryName)
    let file
    try {
      await output.check(); await check()
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      await file.writeFile(input.bytes); await file.sync(); await file.close(); file = null
      await verifyFile(temporary, input)
      signal?.throwIfAborted(); await check(); await output.check()
      // Android may forbid hardlinks even inside app-private storage. Exclusive copy
      // never overwrites a final path, but copying is not filesystem-atomic: only a
      // fully verified file can be registered/delivered. Unknown partials stay private.
      try { await copyFile(canonicalTemporary, path, constants.COPYFILE_EXCL) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await output.check()
      await verifyFile(ioPath, input, true); await output.check()
      await rm(temporary)
      const bound = await check()
      entry.groups = bound.groups; entry.permissionRequirements = bound.permissionRequirements; entry.file_path = path
      const registered = await registerArtifact({ store, agent, groups: bound.groups, file: { file_path: path, name: input.name, mime_type: input.mime, size: input.bytes.length, sha256: input.sha256, permissionRequirements: structuredClone(bound.permissionRequirements) } })
      if (registered.file_path !== path) {
        delete store.state.artifacts[registered.artifact_id]
        await store.save()
        throw fail('file_changed', '任务输出路径在登记期间发生变化，未交付文件')
      }
      entry.status = 'ready'; entry.artifactId = registered.artifact_id
      await store.save(); await output.check(); await verifyFile(path, input); await output.check(); await check(bound)
      const data = { ok: true, ...registered }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    } finally {
      await file?.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      await output.close()
    }
  }
  return { name: 'phone_file_write', label: '生成任务文本文件', description: '把当前任务的文本保存为本机私有产物，随后可用 phone_file_list/read 查看，或 message_send_file 发到有权发送的咕咕聊天。只提供 file_name（单个文件名，不含路径）和 text；支持 Markdown、纯文本、CSV、JSON、HTML 等 UTF-8 文本，单文件最多1 MiB。不能生成 PDF、Office 或二进制文件。不会覆盖已有不同内容；同一次工具调用重试返回相同产物。手机数据授权随产物保留，撤权后不能读取或发送。',
    parameters: { type: 'object', additionalProperties: false, required: ['file_name', 'text'], properties: { file_name: { type: 'string', description: '例如 report.md，不能含目录、路径或隐藏文件名' }, text: { type: 'string', description: '要保存的完整 UTF-8 文本，最多1 MiB' } } },
    execute: async (callId, args, signal) => {
      if (typeof callId !== 'string' || !callId || callId.length > 512 || Array.from(callId).some(invalidCallIdCharacter)) throw fail('invalid_args', '工具调用编号无效，不能安全登记产物')
      const input = contentOf(args)
      const id = stableId('phone-text-output', uuid(store.state.ownerId), uuid(agent.agentUserId), uuid(agent.sessionId), uuid(job.id, 'jobId'), callId)
      const fingerprint = stableId(input.name, input.mime, input.sha256)
      const existing = inflight.get(id)
      if (existing) { if (existing.fingerprint !== fingerprint) throw fail('invalid_args', '同一工具调用不能改名或改内容'); return existing.promise }
      const promise = write(callId, input, id, fingerprint, signal)
      inflight.set(id, { fingerprint, promise })
      try { return await promise } finally { if (inflight.get(id)?.promise === promise) inflight.delete(id) }
    },
  }
}
