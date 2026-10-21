import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { DeviceActionResult } from '@gugu/core/shared/deviceActions'
import { receivePhoneDeviceFile } from '../../../../apps/desktop/electron/phone-device-file'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'phone-file-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const signal = () => new AbortController().signal
function result(bytes: Buffer, offset = 0, size = bytes.length, extra: Record<string, unknown> = {}): DeviceActionResult {
  return { v: 1, ok: true, call_id: 'test-call', data: { phone_file_chunk: {
    name: 'meeting.wav', mime_type: 'audio/wav', version: '1:100:2', total_size: size, offset,
    data_base64: bytes.toString('base64'), eof: offset + bytes.length === size, ...extra,
  } } }
}

describe('phone media files never enter model text as base64', () => {
  it('assembles binary chunks on disk with exact bytes and digest', async () => {
    const bytes = Buffer.from([0, 255, 12, 42, 128, 0])
    const read = vi.fn(async () => result(bytes.subarray(3), 3, bytes.length))
    const answer = await receivePhoneDeviceFile({ first: result(bytes.subarray(0, 3), 0, bytes.length), root, signal: signal(), args: { id: '1' }, read })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    const data = answer.data as { file_path: string; size: number; sha256: string }
    expect(await readFile(data.file_path)).toEqual(bytes)
    expect(data.size).toBe(bytes.length)
    expect(data.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(JSON.stringify(answer)).not.toContain('data_base64')
    expect(read).toHaveBeenCalledWith({ id: '1', offset: 3, version: '1:100:2' })
  })
  it.each(['offset', 'total_size', 'version'])('rejects a changed %s and removes the entire partial transfer', async (field) => {
    const changed = { offset: 7, total_size: 99, version: 'changed' }[field]
    const answer = await receivePhoneDeviceFile({ first: result(Buffer.from('a'), 0, 2), root, signal: signal(), args: { id: '1' }, read: async () => result(Buffer.from('b'), 1, 2, { [field]: changed }) })
    expect(answer).toMatchObject({ ok: false, code: 'execution_failed' })
    expect(await readdir(root)).toEqual([])
  })
  it('does not hand out bytes when access is revoked between chunks', async () => {
    const answer = await receivePhoneDeviceFile({ first: result(Buffer.from('a'), 0, 2), root, signal: signal(), args: {}, read: async () => ({ v: 1, ok: false, call_id: 'next', code: 'revoked', message: 'revoked' }) })
    expect(answer).toMatchObject({ ok: false, code: 'revoked' })
    expect(await readdir(root)).toEqual([])
  })
  it('rejects truncated, zero-progress and malformed blocks', async () => {
    for (const extra of [{ eof: true }, { data_base64: '' }, { data_base64: 'not base64' }]) {
      const answer = await receivePhoneDeviceFile({ first: result(Buffer.from('a'), 0, 2, extra), root, signal: signal(), args: {}, read: vi.fn() })
      expect(answer.ok).toBe(false)
      expect(await readdir(root)).toEqual([])
    }
  })
  it('keeps preview image blocks outside the file chunk and neutralizes path traversal names', async () => {
    const first = result(Buffer.from('image'), 0, 5, { name: '../../photo.jpg', mime_type: 'image/jpeg' })
    if (first.ok) (first.data as Record<string, unknown>).pictures = [{ label: 'photo', mimeType: 'image/jpeg', data: 'preview' }]
    const answer = await receivePhoneDeviceFile({ first, root, signal: signal(), args: {}, read: vi.fn() })
    expect(answer.ok).toBe(true)
    if (answer.ok) {
      const data = answer.data as { file_path: string; pictures: unknown[] }
      expect(data.file_path.startsWith(root + '/read-')).toBe(true)
      expect(data.file_path.endsWith('/photo.jpg')).toBe(true)
      expect(data.pictures).toHaveLength(1)
    }
  })
  it('respects cancellation and passes non-file results through untouched', async () => {
    const controller = new AbortController(); controller.abort()
    expect((await receivePhoneDeviceFile({ first: result(Buffer.from('x')), root, signal: controller.signal, args: {}, read: vi.fn() })).ok).toBe(false)
    const first: DeviceActionResult = { v: 1, ok: true, call_id: 'list', data: { messages: [] } }
    expect(await receivePhoneDeviceFile({ first, root, signal: signal(), args: {}, read: vi.fn() })).toBe(first)
  })
})
