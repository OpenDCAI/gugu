import { describe, expect, it, vi } from 'vitest'
import { createAttachmentFileSelection } from '../../../apps/desktop/src/lib/attachmentFileSelection'
const files = (count: number) => Array.from({ length: count }, (_, i) => new File(['x'], `${i}.txt`))
describe('attachment intake capacity', () => {
  it('accepts the first ten original files and reports excess once', () => {
    const limit = vi.fn(), selection = createAttachmentFileSelection(limit), incoming = files(12)
    expect(selection.choose(incoming, true).map(item => item.file)).toEqual(incoming.slice(0, 10))
    expect(limit).toHaveBeenCalledTimes(1)
  })
  it('reserves capacity across consecutive events before any preview finishes', () => {
    const limit = vi.fn(), selection = createAttachmentFileSelection(limit)
    const first = selection.choose(files(6), true)
    const second = selection.choose(files(6), true)
    expect(first).toHaveLength(6)
    expect(second).toHaveLength(4)
    selection.observe(first)
    expect(selection.choose(files(1), true)).toEqual([])
    selection.observe([...first, ...second])
    selection.observe([...first, ...second].slice(1))
    expect(selection.choose(files(2), true)).toHaveLength(1)
    expect(limit).toHaveBeenCalledTimes(3)
  })
  it('reconciles adapter-owned IDs without losing duplicate-file reservations', () => {
    const selection = createAttachmentFileSelection(vi.fn()), same = files(1)[0]!
    selection.choose([same, same, ...files(8)], true)
    selection.observe([{ id: 'adapter-1', file: same }])
    expect(selection.choose(files(1), true)).toEqual([])
    selection.observe([{ id: 'adapter-1', file: same }, { id: 'adapter-2', file: same }])
    expect(selection.choose(files(1), true)).toEqual([])
  })
  it('releases reservations if preparation fails or a direct picker send finishes', () => {
    const selection = createAttachmentFileSelection(vi.fn())
    const failed = selection.choose(files(8), true)
    selection.release(failed)
    expect(selection.choose(files(10), true)).toHaveLength(10)
  })
  it('does not limit desktop additions or rewrite an already restored draft', () => {
    const limit = vi.fn(), selection = createAttachmentFileSelection(limit)
    const restored = Array.from({ length: 12 }, (_, i) => ({ id: `restored-${i}` }))
    selection.observe(restored)
    expect(selection.choose(files(20), false)).toHaveLength(20)
    expect(limit).not.toHaveBeenCalled()
    expect(restored).toHaveLength(12)
  })
  it('does not notify for an empty selection or for exactly the available capacity', () => {
    const limit = vi.fn(), selection = createAttachmentFileSelection(limit)
    selection.observe([{ id: 'existing' }])
    expect(selection.choose([], true)).toEqual([])
    expect(selection.choose(files(9), true)).toHaveLength(9)
    expect(limit).not.toHaveBeenCalled()
  })
})
