import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

const fail = (code, message) => Object.assign(new Error(message), { code })
const textTypes = /^(?:text\/|application\/(?:json|xml|javascript|x-yaml|yaml|toml)(?:[;+]|$))/i
const textExtension = /\.(?:txt|md|csv|tsv|json|jsonl|log|ya?ml|xml|ics|toml|ini|js|mjs|cjs|ts|tsx|jsx|py|java|kt|css|html?|sql|sh)$/i

/** Folder attachments expose their registered children, never an arbitrary filesystem listing. */
export function phoneArtifactListTool({ agent, job, store, authorize }) {
  return { name: 'phone_file_list', label: '查看任务附件', description: '列出当前手机任务已经上传、下载或读取并登记的附件。文件夹附件用 folder_path 指定工具给出的私有目录，返回其中已登记文件的 file_path，随后用 phone_file_read 读取文本；不会扫描任意手机目录。按 next_offset 翻页。',
    parameters: { type: 'object', properties: { folder_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 500 } } },
    execute: async (_callId, args) => {
      const offset = args.offset ?? 0
      const limit = args.limit ?? 100
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || args.folder_path !== undefined && (typeof args.folder_path !== 'string' || !args.folder_path)) throw fail('invalid_args', '附件目录或分页参数无效')
      const prefix = args.folder_path?.replace(/\/+$/, '')
      const all = Object.values(store.state.artifacts ?? {}).filter((entry) => entry.ownerId === store.state.ownerId && entry.agentUserId === agent.agentUserId && entry.sessionId === agent.sessionId && (!prefix || entry.file_path.startsWith(`${prefix}/`))).sort((a, b) => a.file_path.localeCompare(b.file_path))
      const shown = all.slice(offset, offset + limit)
      const groups = [...new Set([...(job.usedGroups ?? []), ...shown.flatMap((entry) => entry.groups ?? [])])]
      const requirements = [...new Map([...(job.permissionRequirements ?? []), ...shown.flatMap((entry) => entry.permissionRequirements ?? [])].map((proof) => [JSON.stringify(proof), proof])).values()]
      const proof = { sessionId: agent.sessionId, permissionRequirements: requirements }
      await authorize(groups, proof)
      job.usedGroups = groups; job.permissionRequirements = requirements
      await store.save()
      await authorize(groups, proof)
      const data = { files: shown.map((entry) => ({ file_path: entry.file_path, name: entry.name, mime_type: entry.mime_type, size: entry.size, sha256: entry.sha256 })), total: all.length, next_offset: Math.min(all.length, offset + limit), eof: offset + limit >= all.length }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    },
  }
}

/** Bounded UTF-8 pages from an already registered artifact. Full-file hash/size checks and
 * permission checks surround reading; no arbitrary file path or binary parser is exposed. */
export function phoneTextFileTool({ agent, job, store, authorize }) {
  return { name: 'phone_file_read', label: '读取任务文本附件', description: '读取本任务上传、聊天附件下载或手机工具已登记的 UTF-8 文本文件。file_path 必须用登记后的完整私有路径；不能读任意手机文件。offset 是 Unicode 字符偏移，limit 每次最多32768字符，按 next_offset 继续直到 eof。当前不解析 PDF、Office、图片、视频或音频；这些二进制文件可原样发送，不要声称读过内容。',
    parameters: { type: 'object', required: ['file_path'], properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32768 } } },
    execute: async (_callId, args, signal) => {
      const offset = args.offset ?? 0
      const limit = args.limit ?? 8192
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32768) throw fail('invalid_args', '文本读取位置或每页字符数无效')
      const file = Object.values(store.state.artifacts ?? {}).find((entry) => entry.file_path === args.file_path && entry.ownerId === store.state.ownerId && entry.agentUserId === agent.agentUserId && entry.sessionId === agent.sessionId)
      if (!file) throw fail('not_granted', '只能读取当前手机任务已登记的附件，请先上传文件或下载聊天附件')
      if (!textTypes.test(file.mime_type ?? '') && !textExtension.test(extname(file.name ?? file.file_path))) throw fail('unsupported', '当前手机工具只读取 UTF-8 文本，不解析这个二进制文件')
      const groups = [...new Set([...(job.usedGroups ?? []), ...(file.groups ?? [])])]
      await authorize(groups, file)
      if (await realpath(file.file_path) !== file.file_path) throw fail('file_changed', '登记文件路径已改变，未读取')
      const before = await stat(file.file_path)
      if (!before.isFile() || before.size !== file.size) throw fail('file_changed', '登记文件大小已改变，未读取')
      const hash = createHash('sha256')
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let total = 0
      let selected = ''
      const take = (text) => {
        if (text.includes('\0')) throw fail('unsupported', '这个文件含二进制内容，当前手机工具不解析')
        const characters = Array.from(text)
        const from = Math.max(0, offset - total)
        const until = Math.min(characters.length, offset + limit - total)
        if (until > from) selected += characters.slice(from, until).join('')
        total += characters.length
      }
      try {
        for await (const chunk of createReadStream(file.file_path, { ...(signal ? { signal } : {}) })) { signal?.throwIfAborted(); hash.update(chunk); take(decoder.decode(chunk, { stream: true })) }
        take(decoder.decode())
      } catch (error) { if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') throw fail('unsupported', '这个文件不是 UTF-8 文本，当前手机工具不解析'); throw error }
      if (hash.digest('hex') !== file.sha256 || (await stat(file.file_path)).size !== file.size || await realpath(file.file_path) !== file.file_path) throw fail('file_changed', '登记文件内容已改变，未交付文本')
      await authorize(groups, file)
      job.usedGroups = groups
      job.permissionRequirements = [...new Map([...(job.permissionRequirements ?? []), ...(file.permissionRequirements ?? [])].map((proof) => [JSON.stringify(proof), proof])).values()]
      await store.save()
      await authorize(groups, file)
      const next = Math.min(total, offset + limit)
      const data = { ok: true, file_path: file.file_path, sha256: file.sha256, text: selected, offset, next_offset: next, total_chars: total, eof: next >= total }
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: data }
    },
  }
}
