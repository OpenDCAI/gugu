// workspace/list.js (pure): which kind a file is, its mark, its size in words, the time section, the time a cloud copy has left.
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { comparer, kindOf, markOf, sectionOf, sizeOf, timeLeft } from '../../../../apps/desktop/preinstalled-apps/workspace/list.js'

const f = (name: string, contentType: string, more: Record<string, unknown> = {}) => ({ name, contentType, type: 'binary', ...more })

describe('workspace list helpers', () => {
  test('kinds: documents by type or suffix, images and videos, the rest; a folder is none', () => {
    expect(kindOf(f('a.pdf', 'application/pdf'))).toBe('docs')
    expect(kindOf(f('b.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe('docs')
    expect(kindOf(f('notes', 'text/markdown', { type: 'text' }))).toBe('docs')
    expect(kindOf(f('data.csv', 'application/octet-stream'))).toBe('docs')
    expect(kindOf(f('shot.png', 'image/png'))).toBe('media')
    expect(kindOf(f('clip.mov', 'video/quicktime'))).toBe('media')
    expect(kindOf(f('pack.zip', 'application/zip'))).toBe('other')
    expect(kindOf({ ...f('dir', 'inode/directory'), type: 'folder' })).toBe(null)
  })

  test('a mark is the suffix, coloured by family; a name without one goes by its type', () => {
    expect(markOf(f('Q3 report.PDF', 'application/pdf'))).toEqual({ label: 'PDF', family: 'pdf' })
    expect(markOf(f('model.tar.gz', 'application/gzip'))).toEqual({ label: 'GZ', family: 'archive' })
    expect(markOf(f('a.vote.json', 'application/json', { suffix: '.vote.json' }))).toEqual({ label: 'JSON', family: 'text' })
    expect(markOf(f('README', 'image/png'))).toEqual({ label: 'IMAG', family: 'image' })
    expect(markOf(f('blob', 'application/octet-stream'))).toEqual({ label: '', family: 'other' })
  })

  test('sizes in words', () => {
    expect([sizeOf(0), sizeOf(1023), sizeOf(1024), sizeOf(19_600 * 1024), sizeOf(2.4 * 1024 ** 3), sizeOf(null)]).toEqual(['0 B', '1023 B', '1 KB', '19.1 MB', '2.4 GB', ''])
  })

  test('sections by the local day: today, yesterday, the past week, then the month', () => {
    const now = new Date(2026, 9, 28, 12, 0)
    expect(sectionOf(new Date(2026, 9, 28, 0, 5).toISOString(), now).key).toBe('today')
    expect(sectionOf(new Date(2026, 9, 27, 23, 59).toISOString(), now).key).toBe('yesterday')
    expect(sectionOf(new Date(2026, 9, 22, 9).toISOString(), now).key).toBe('week')
    expect(sectionOf(new Date(2026, 9, 21, 9).toISOString(), now)).toMatchObject({ kind: 'month', year: 2026, month: 10 })
    expect(sectionOf(null, now).key).toBe('earlier')
  })

  test('time left on a cloud copy: days, hours, minutes; none when kept or past', () => {
    const now = new Date('2026-10-28T12:00:00Z')
    expect(timeLeft('2026-11-03T13:00:00Z', now)).toEqual({ days: 6 })
    expect(timeLeft('2026-10-28T17:30:00Z', now)).toEqual({ hours: 5 })
    expect(timeLeft('2026-10-28T12:00:20Z', now)).toEqual({ minutes: 1 })
    expect([timeLeft(null, now), timeLeft('2026-10-28T11:59:00Z', now)]).toEqual([null, null])
  })

  test('orders: by name numerically, by size largest first with names breaking ties', () => {
    const name = (e: { name: string }) => e.name
    const at = () => ''
    const files = [{ name: 'a10', size: 1 }, { name: 'a2', size: 5 }, { name: 'b', size: 5 }, { name: 'c', size: null }]
    expect([...files].sort(comparer('name', name, at, 'en')).map(name)).toEqual(['a2', 'a10', 'b', 'c'])
    expect([...files].sort(comparer('size', name, at, 'en')).map(name)).toEqual(['a2', 'b', 'a10', 'c'])
  })
})
