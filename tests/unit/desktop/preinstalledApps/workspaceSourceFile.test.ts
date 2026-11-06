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
  const io = {
    read: vi.fn(async () => ({ content: onDisk.value })),
    write: vi.fn(async (text: string) => { onDisk.value = text }),
  }
  const onError = vi.fn()
  const onDocument = vi.fn()
  const file = sourceFile({ io, text: { mergeThreeWay, diffHunks }, onChange: () => undefined, onError, onDocument })
  file.load(content)
  file.attach({
    text: () => doc,
    apply: (hunks: Hunk[]) => {
      for (const hunk of [...hunks].reverse()) doc = doc.slice(0, hunk.from) + hunk.insert + doc.slice(hunk.to)
    },
  })
  return { file, io, onDisk, onError, onDocument, doc: () => doc, type: (next: string) => { doc = next; file.edited() } }
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

  test('a save refused as conflict reads again, merges, and writes once more', async () => {
    const r = rig('one\ntwo\nthree\n')
    r.type('ONE\ntwo\nthree\n')
    r.io.write.mockImplementationOnce(async () => {
      r.onDisk.value = 'one\ntwo\nTHREE\n'
      throw Object.assign(new Error('replaced'), { code: 'conflict' })
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

  test('saved into something that opens live: the page is told', async () => {
    const r = rig('[1]\n')
    r.type('{"a":1}\n')
    r.io.read.mockResolvedValueOnce({ becameDocument: true } as never)
    await r.file.save()
    expect(r.onDocument).toHaveBeenCalledOnce()
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
