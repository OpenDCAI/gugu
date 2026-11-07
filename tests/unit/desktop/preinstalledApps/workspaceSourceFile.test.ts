// A file edited as a whole (workspace/source-file.js): the host text models' meaning of unsaved, merge, conflict and gone,
// over the platform's own merge. The editor and the file calls are handed in, so the rules are judged here.
import { describe, expect, test, vi } from 'vitest'
import { diffHunks, mergeThreeWay } from '../../../../apps/desktop/src/session/app-runtime/apply-from'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { bufferAnchors, firstBytes, sourceFile } from '../../../../apps/desktop/preinstalled-apps/workspace/source-file.js'

type Hunk = { from: number; to: number; insert: string }

function rig(content: string) {
  let doc = content.replace(/\r\n?/g, '\n')
  const onDisk = { value: content }
  const drafts = { value: null as string | null }
  const io = {
    read: vi.fn(async () => ({ content: onDisk.value } as Record<string, unknown>)),
    write: vi.fn(async (text: string) => { onDisk.value = text }),
    draft: {
      get: async () => drafts.value,
      put: vi.fn(async (text: string) => { drafts.value = text }),
      clear: vi.fn(async () => { drafts.value = null }),
    },
  }
  const onError = vi.fn()
  const file = sourceFile({ io, text: { mergeThreeWay, diffHunks }, onChange: () => undefined, onError })
  void file.load(0, { content })
  file.attach({
    text: () => doc,
    apply: (hunks: Hunk[]) => {
      for (const hunk of [...hunks].reverse()) doc = doc.slice(0, hunk.from) + hunk.insert + doc.slice(hunk.to)
    },
  })
  return { file, io, onDisk, drafts, onError, doc: () => doc, type: (next: string) => { doc = next; file.edited() } }
}

describe('a file edited as a whole', () => {
  test('unsaved means the buffer and the file differ, and typing back clears it', () => {
    const r = rig('a\n')
    r.type('ab\n')
    expect(r.file.dirty).toBe(true)
    r.type('a\n')
    expect(r.file.dirty).toBe(false)
  })

  test('a save writes the file with its own line ending', async () => {
    const r = rig('a\r\nb\r\n')
    r.type('a\nc\n')
    expect(await r.file.save()).toBe(true)
    expect(r.onDisk.value).toBe('a\r\nc\r\n')
    expect(r.file.dirty).toBe(false)
  })

  test('nothing unsaved: a save writes nothing (a chat file would gain an empty version)', async () => {
    const r = rig('a\n')
    expect(await r.file.save()).toBe(true)
    expect(r.io.write).not.toHaveBeenCalled()
  })

  test('the file changed with no unsaved edits: the buffer becomes it', async () => {
    const r = rig('a\n')
    r.onDisk.value = 'b\n'
    await r.file.refresh()
    expect(r.doc()).toBe('b\n')
    expect(r.file.dirty).toBe(false)
  })

  test('the file changed beside unsaved edits: both stay, still unsaved', async () => {
    const r = rig('one\ntwo\nthree\n')
    r.type('ONE\ntwo\nthree\n')
    r.onDisk.value = 'one\ntwo\nTHREE\n'
    await r.file.refresh()
    expect(r.doc()).toBe('ONE\ntwo\nTHREE\n')
    expect(r.file.dirty).toBe(true)
  })

  test('a save refused as content-changed reads again, merges, and writes once more', async () => {
    const r = rig('one\ntwo\nthree\n')
    r.type('ONE\ntwo\nthree\n')
    r.io.write.mockImplementationOnce(async () => {
      r.onDisk.value = 'one\ntwo\nTHREE\n'
      throw Object.assign(new Error('replaced'), { code: 'content-changed' })
    })
    expect(await r.file.save()).toBe(true)
    expect(r.onDisk.value).toBe('ONE\ntwo\nTHREE\n')
    expect(r.file.dirty).toBe(false)
  })

  test('a save that fails says so and keeps the edits', async () => {
    const r = rig('a\n')
    r.type('b\n')
    r.io.write.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'failed' }))
    expect(await r.file.save()).toBe(false)
    expect(r.onError).toHaveBeenCalledOnce()
    expect(r.doc()).toBe('b\n')
    expect(r.file.dirty).toBe(true)
  })

  test('deleted: said, and the text stays; unreachable is not deleted', async () => {
    const r = rig('a\n')
    r.io.read.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'failed' }))
    await r.file.refresh()
    expect(r.file.deleted).toBe(false)
    r.io.read.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not-found' }))
    await r.file.refresh()
    expect(r.file.deleted).toBe(true)
    expect(r.doc()).toBe('a\n')
  })

  test('a change during a read is read again: an emptied file seen last is not what the buffer keeps', async () => {
    const r = rig('a\n')
    let finishFirst = (_: { content: string }) => undefined as void
    r.io.read.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    const first = r.file.refresh()
    r.onDisk.value = 'filled\n'
    void r.file.refresh()
    finishFirst({ content: '' })
    await first
    expect(r.doc()).toBe('filled\n')
    expect(r.file.dirty).toBe(false)
  })

  test('grown past the limit: said, and no half text over the buffer', async () => {
    const r = rig('a\n')
    r.io.read.mockResolvedValueOnce({ content: '', truncated: true, totalSize: 99 })
    await r.file.refresh()
    expect(r.file.tooLarge).toBe(99)
    expect(r.doc()).toBe('a\n')
  })

  test('a save after it was deleted makes the file again', async () => {
    const r = rig('a\n')
    r.io.read.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'not-found' }))
    await r.file.refresh()
    expect(await r.file.save()).toBe(true)
    expect(r.io.write).toHaveBeenCalledOnce()
    expect(r.file.deleted).toBe(false)
  })

  test('edits survive a crash: kept after a pause, or as the page goes; a save or discarding clears them', async () => {
    vi.useFakeTimers()
    try {
      const r = rig('a\n')
      r.type('b\n')
      expect(r.io.draft.put).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2000)
      expect(r.drafts.value).toBe('b\n')
      r.type('c\n')
      r.file.flush()
      expect(r.drafts.value).toBe('c\n')
      await r.file.save()
      expect(r.drafts.value).toBeNull()
      r.type('d\n')
      r.file.flush()
      r.file.discard()
      expect(r.drafts.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('what a crash left opens as the text, unsaved', async () => {
    const r = rig('a\n')
    r.drafts.value = 'from the crash\r\n'
    const again = sourceFile({ io: r.io, text: { mergeThreeWay, diffHunks }, onChange: () => undefined, onError: r.onError })
    expect(await again.load(0, { content: 'a\n' })).toEqual({ kind: 'text', initial: 'from the crash\n' })
    again.attach({ text: () => 'from the crash\n', apply: () => undefined })
    expect(again.dirty).toBe(true)
  })

  test('read empty where it was not: read once more, and taken only if it is still empty', async () => {
    const r = rig('a\n')
    r.io.read.mockClear()
    r.onDisk.value = 'filled\n'
    r.io.read.mockResolvedValueOnce({ content: '' })
    await r.file.refresh()
    expect(r.io.read).toHaveBeenCalledTimes(2)
    expect(r.doc()).toBe('filled\n')

    r.io.read.mockClear()
    r.onDisk.value = ''
    await r.file.refresh()
    expect(r.io.read).toHaveBeenCalledTimes(2)
    expect(r.doc()).toBe('')
    expect(r.file.dirty).toBe(false)
  })

  test('a change during a read is read again: an emptied file seen last is not what the buffer keeps', async () => {
    const r = rig('a\n')
    let finishFirst = (_: { content: string }) => undefined as void
    r.io.read.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve }))
    const first = r.file.refresh()
    r.onDisk.value = 'filled\n'
    void r.file.refresh()
    finishFirst({ content: '' })
    await first
    expect(r.doc()).toBe('filled\n')
    expect(r.file.dirty).toBe(false)
  })

  test('read empty where it was not: read once more, and taken only if it is still empty', async () => {
    const r = rig('a\n')
    r.io.read.mockClear()
    r.onDisk.value = 'filled\n'
    r.io.read.mockResolvedValueOnce({ content: '' })
    await r.file.refresh()
    expect(r.io.read).toHaveBeenCalledTimes(2)
    expect(r.doc()).toBe('filled\n')

    r.io.read.mockClear()
    r.onDisk.value = ''
    await r.file.refresh()
    expect(r.io.read).toHaveBeenCalledTimes(2)
    expect(r.doc()).toBe('')
    expect(r.file.dirty).toBe(false)
  })

  test('discarding goes back to the file', () => {
    const r = rig('a\n')
    r.type('b\n')
    r.file.discard()
    expect(r.doc()).toBe('a\n')
    expect(r.file.dirty).toBe(false)
  })
})

describe('places in the buffer', () => {
  test('stay on their words as the text changes', () => {
    const anchors = bufferAnchors()
    const place = anchors.anchor(5)
    anchors.moved({ mapPos: (at: number) => at + 2 })
    expect(anchors.resolve(place)).toBe(7)
    expect(anchors.resolve({ at: 1, assoc: 1 })).toBeNull()
  })
})

describe('firstBytes', () => {
  const bytesOf = (text: string) => new TextEncoder().encode(text).length
  test('ends at a line, counted in bytes rather than characters', () => {
    expect(firstBytes('一二三\n四五六\n七八九\n', 10)).toBe('一二三')
    expect(firstBytes('一二三\n四五六\n七八九\n', 21)).toBe('一二三\n四五六')
  })
  test('a line longer than the limit is cut without splitting a character', () => {
    const cut = firstBytes('一二三四五六七八九', 10)
    expect(cut).toBe('一二三')
    expect(bytesOf(cut)).toBeLessThanOrEqual(10)
    expect(firstBytes('😀😀😀', 6)).toBe('😀')
  })
  test('a text within the limit stays whole', () => {
    expect(firstBytes('a\nb', 100)).toBe('a\nb')
  })
})
