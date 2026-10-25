import { describe, expect, it } from 'vitest'
import { createCachedFileSink, type FileChunkCache } from '../../../../packages/core/src/shared/fileCache'

function fixture(size: number) {
  const rows = new Map<string, Uint8Array>()
  const cache: FileChunkCache = { get: async (key, index) => rows.get(`${key}:${index}`) ?? null, put: async (key, index, bytes) => { rows.set(`${key}:${index}`, bytes.slice()) }, clear: async key => { for (const row of rows.keys()) if (row.startsWith(`${key}:`)) rows.delete(row) } }
  return { rows, sink: createCachedFileSink(cache, size) }
}
describe('bounded private browser staging in the existing cache', () => {
  it('does not publish an incomplete file, and reads across frame boundaries after exact commit', async () => {
    const f = fixture(6)
    await f.sink.write(new Uint8Array([1, 2])); await expect(f.sink.commit()).rejects.toThrow('Incomplete')
    await f.sink.write(new Uint8Array([3, 4, 5, 6]))
    const file = await f.sink.commit()
    expect(await file.read(1, 4)).toEqual(new Uint8Array([2, 3, 4, 5]))
    const bytes = await file.read(0, 2); bytes[0] = 99
    expect(await file.read(0, 2)).toEqual(new Uint8Array([1, 2]))
    await expect(f.sink.write(new Uint8Array())).rejects.toThrow('closed')
    await file.dispose(); expect(f.rows.size).toBe(0)
    await expect(file.read(0, 1)).rejects.toThrow('disposed')
  })
  it('aborts only its own random namespace and refuses truncated or missing staged chunks', async () => {
    const f = fixture(1)
    f.rows.set('other:0', new Uint8Array([7])); await f.sink.write(new Uint8Array([1]))
    const file = await f.sink.commit()
    for (const key of f.rows.keys()) if (key !== 'other:0') f.rows.delete(key)
    await expect(file.read(0, 1)).rejects.toThrow('removed or changed')
    await f.sink.abort(); expect([...f.rows.keys()]).toEqual(['other:0'])
  })
  it('enforces exact bounded writes, safe ranges and the empty file', async () => {
    const f = fixture(1)
    await expect(f.sink.write(new Uint8Array(2))).rejects.toThrow('Invalid file range')
    const empty = await fixture(0).sink.commit()
    expect(await empty.read(0, 0)).toEqual(new Uint8Array())
    await expect(empty.read(0, 1)).rejects.toThrow('Invalid file range')
    await empty.dispose()
  })
})
