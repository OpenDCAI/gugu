import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { stageFileHandle, stageFileSource, FILE_CHUNK_BYTES, type FileStageCommand } from '@gugu/core/shared/fileResolver'
import { verifiedFileHandle } from '../../../support/verifiedFileHandle'

describe('verified originals cross a native bridge only in bounded frames', () => {
  it('sends the exact committed binary original and original filename, then only an opaque native id', async () => {
    const bytes = Uint8Array.from({ length: FILE_CHUNK_BYTES * 2 + 1 }, (_, i) => i % 251), received: Uint8Array[] = []
    const file = await verifiedFileHandle(bytes, { file_name: 'original.bin' })
    const send = vi.fn(async (command: FileStageCommand) => {
      if (command.op === 'begin') {
        expect(command.name).toBe('保存名字.bin'); expect(command.revision.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
        expect('url' in command).toBe(false); return { id: 'opaque-private-file' }
      }
      expect(command.id).toBe('opaque-private-file')
      if (command.op === 'chunk') { expect(command.bytes.length).toBeLessThanOrEqual(FILE_CHUNK_BYTES); received.push(command.bytes.slice()) }
    })
    expect(await stageFileHandle(file, '保存名字.bin', send)).toBe('opaque-private-file')
    expect(send.mock.calls.map(([command]) => command.op)).toEqual(['begin', 'chunk', 'chunk', 'chunk', 'commit'])
    expect(Buffer.concat(received)).toEqual(Buffer.from(bytes))
    await expect(file.read(0, 1)).rejects.toThrow('disposed')
  })
  it('aborts exactly its own private stage on a bridge failure, never commits or leaves a live original handle', async () => {
    const file = await verifiedFileHandle(new Uint8Array([1, 2, 3])), operations: string[] = []
    await expect(stageFileHandle(file, 'file.bin', async command => {
      operations.push(command.op)
      if (command.op === 'begin') return { id: 'own-stage' }
      expect(command.id).toBe('own-stage')
      if (command.op === 'chunk') throw Error('native refused frame')
    })).rejects.toThrow('native refused frame')
    expect(operations).toEqual(['begin', 'chunk', 'abort'])
    await expect(file.read(0, 1)).rejects.toThrow('disposed')
  })
  it.each([
    { size: 2, frames: [new Uint8Array([1])], error: 'Incomplete native file stage' },
    { size: 1, frames: [new Uint8Array([1, 2])], error: 'Invalid file range' },
    { size: FILE_CHUNK_BYTES + 1, frames: [new Uint8Array(FILE_CHUNK_BYTES + 1)], error: 'Invalid file range' },
  ])('generated sources cannot bypass exact size or frame bounds ($size)', async ({ size, frames, error }) => {
    const dispose = vi.fn(async () => {})
    const send = vi.fn(async (command: FileStageCommand) => command.op === 'begin' ? { id: 'own-stage' } : undefined)
    await expect(stageFileSource({ revision: { size_bytes: size, sha256: 'a'.repeat(64), content_type: 'application/octet-stream' },
      async *stream() { yield* frames }, dispose }, 'generated.bin', send)).rejects.toThrow(error)
    expect(send).toHaveBeenLastCalledWith({ op: 'abort', id: 'own-stage' })
    expect(send.mock.calls.some(([command]) => command.op === 'commit')).toBe(false)
    expect(dispose).toHaveBeenCalledOnce()
  })
  it('empty sources still begin and commit with their exact commitment and dispose', async () => {
    const dispose = vi.fn(async () => {})
    const send = vi.fn(async (command: FileStageCommand) => command.op === 'begin' ? { id: 'own-stage' } : undefined)
    expect(await stageFileSource({ revision: { size_bytes: 0, sha256: createHash('sha256').digest('hex'), content_type: 'application/octet-stream' },
      async *stream() {}, dispose }, 'empty', send)).toBe('own-stage')
    expect(send.mock.calls.map(([command]) => command.op)).toEqual(['begin', 'commit'])
    expect(dispose).toHaveBeenCalledOnce()
  })
})
