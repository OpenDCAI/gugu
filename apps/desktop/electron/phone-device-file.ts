import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DeviceActionResult, DeviceActionErrorCode } from '@gugu/core/shared/deviceActions'

interface Chunk {
  offset: number
  total_size: number
  version: string
  name: string
  mime_type: string
  data_base64: string
  eof: boolean
}

class ReadRefused extends Error {
  constructor(readonly code: DeviceActionErrorCode, message: string) { super(message) }
}

function chunkOf(result: DeviceActionResult): Chunk {
  if (!result.ok) throw new ReadRefused(result.code, result.message)
  const raw = (result.data as { phone_file_chunk?: unknown } | null)?.phone_file_chunk
  if (!raw || typeof raw !== 'object') throw new Error('手机未返回文件块')
  const c = raw as Chunk
  if (!Number.isSafeInteger(c.offset) || c.offset < 0 || !Number.isSafeInteger(c.total_size) || c.total_size < 0
    || typeof c.version !== 'string' || !c.version || typeof c.name !== 'string' || !c.name
    || typeof c.mime_type !== 'string' || typeof c.data_base64 !== 'string' || typeof c.eof !== 'boolean'
    || c.data_base64.length > 175_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(c.data_base64)) {
    throw new Error('手机返回的文件块无效')
  }
  return c
}

/** The agent gets a complete local file and image blocks, never media base64 as tool text.
 * Each chunk re-enters the phone's normal permission checks. Failed transfers leave no partial file. */
export async function receivePhoneDeviceFile(input: {
  first: DeviceActionResult
  args: Record<string, unknown>
  root: string
  signal: AbortSignal
  read(args: Record<string, unknown>): Promise<DeviceActionResult>
}): Promise<DeviceActionResult> {
  const { first, signal } = input
  if (!first.ok || !first.data || typeof first.data !== 'object' || !('phone_file_chunk' in first.data)) return first
  let dir: string | undefined
  try {
    const initial = chunkOf(first)
    if (initial.offset !== 0) throw new Error('读取必须从文件开头开始')
    signal.throwIfAborted()
    await mkdir(input.root, { recursive: true, mode: 0o700 })
    dir = await mkdtemp(join(input.root, 'read-'))
    const name = Array.from(basename(initial.name.replace(/\\/g, '/')), (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? '_' : c).join('')
    if (!name || name === '.' || name === '..') throw new Error('手机返回的文件名无效')
    const path = join(dir, name)
    const temp = join(dir, '.incomplete')
    const file = await open(temp, 'wx', 0o600)
    const hash = createHash('sha256')
    let offset = 0
    let current = initial
    try {
      for (;;) {
        signal.throwIfAborted()
        if (current.offset !== offset || current.version !== initial.version || current.total_size !== initial.total_size
          || current.name !== initial.name || current.mime_type !== initial.mime_type) throw new Error('文件在传输中发生变化或文件块顺序不符')
        const bytes = Buffer.from(current.data_base64, 'base64')
        if (bytes.toString('base64') !== current.data_base64 || bytes.length > 128 * 1024 || offset + bytes.length > initial.total_size) throw new Error('文件块长度或编码不符')
        if (!bytes.length && !current.eof) throw new Error('手机返回空块,传输没有进展')
        await file.writeFile(bytes)
        hash.update(bytes)
        offset += bytes.length
        if (current.eof) {
          if (offset !== initial.total_size) throw new Error('手机文件未传完整')
          break
        }
        if (offset >= initial.total_size) throw new Error('手机没有正确结束文件传输')
        current = chunkOf(await input.read({ ...input.args, offset, version: initial.version }))
      }
    } finally {
      await file.close()
    }
    signal.throwIfAborted()
    await rename(temp, path)
    const data = first.data as { pictures?: unknown; preview_error?: unknown }
    return { ...first, data: {
      file_path: path, name, mime_type: initial.mime_type, size: offset, sha256: hash.digest('hex'),
      ...(data.pictures ? { pictures: data.pictures } : {}),
      ...(data.preview_error ? { preview_error: data.preview_error } : {}),
    } }
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true })
    return { v: first.v, ok: false, call_id: first.call_id, code: error instanceof ReadRefused ? error.code : 'execution_failed', message: `手机文件未交出:${error instanceof Error ? error.message : String(error)}` }
  }
}
