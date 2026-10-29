// workspace/list.js (pure): which kind a file is, its mark, its size in words, the time section, the time a cloud copy has left.
import { describe, expect, test } from 'vitest'
// @ts-expect-error — 内置 App 是不经构建的纯 ES module,没有类型;运行时 import 可用。
import { comparer, defaultView, keptAs, kindOf, markOf, matches, sectionOf, sizeOf, timeLeft, wantsThumb, whereOf } from '../../../../apps/desktop/preinstalled-apps/workspace/list.js'

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

  test('time left on a cloud copy: days, hours, minutes, rounded up; none when kept or past', () => {
    const now = new Date('2026-10-28T12:00:00Z')
    expect(timeLeft('2026-11-04T11:58:00Z', now), 'just made temporary for 7 days').toEqual({ days: 7 })
    expect(timeLeft('2026-11-03T13:00:00Z', now)).toEqual({ days: 7 })
    expect(timeLeft('2026-10-28T17:30:00Z', now)).toEqual({ hours: 6 })
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

  test.each(['recent', 'size', 'name'])('%s ties use names then ids regardless of input order', (sort) => {
    const files = [
      { id: 'z', name: 'report', size: 5, at: '2026-10-28T12:00:00Z' },
      { id: 'a', name: 'report', size: 5, at: '2026-10-28T12:00:00Z' },
      { id: 'n', name: 'notes', size: 5, at: '2026-10-28T12:00:00Z' },
    ]
    const compare = comparer(sort, (e: typeof files[number]) => e.name, (e: typeof files[number]) => e.at, 'en')
    for (const input of [files, [...files].reverse(), [files[1]!, files[2]!, files[0]!]]) {
      expect([...input].sort(compare).map((e) => e.id)).toEqual(['n', 'a', 'z'])
    }
  })

  test('recent order still puts newer timestamps before names and missing timestamps last', () => {
    const files = [
      { id: 'missing', name: 'a', at: '' },
      { id: 'older', name: 'b', at: '2026-10-27T12:00:00Z' },
      { id: 'newer', name: 'z', at: '2026-10-28T12:00:00Z' },
    ]
    expect(files.sort(comparer('recent', (e: typeof files[number]) => e.name, (e: typeof files[number]) => e.at, 'en'))
      .map((e) => e.id)).toEqual(['newer', 'older', 'missing'])
  })

  test('numeric-equivalent names and absent timestamps still have an id order', () => {
    const files = [{ id: 'z', name: 'a2' }, { id: 'a', name: 'a02' }]
    const name = (e: typeof files[number]) => e.name
    expect([...files].sort(comparer('name', name, () => '', 'en')).map((e) => e.id)).toEqual(['a', 'z'])
    expect([...files].sort(comparer('recent', name, () => '', 'en')).map((e) => e.id)).toEqual(['a', 'z'])
  })
})

describe('workspace list filters and views', () => {
  const now = new Date('2026-10-28T12:00:00Z')
  const machine = (s: { machine: string | null; owner: string }) => s.machine ?? `${s.owner}'s machine`
  const at = (days: number) => new Date(now.getTime() + days * 86400000).toISOString()
  const mine = { createdBy: { id: 'u1' }, keep: { expiresAt: at(3), mine: true } }
  const theirs = { createdBy: { id: 'u2' }, keep: { expiresAt: null, mine: false } }
  const onMachine = { createdBy: { id: 'u1' }, keep: null, storedOn: { machine: 'GF server', owner: 'Me' } }
  const later = { createdBy: { id: 'u2' }, keep: { expiresAt: at(20), mine: false } }
  const pick = (filters: Record<string, string | null>) => [mine, theirs, onMachine, later]
    .filter((e) => matches(e, { who: null, where: null, keep: null, ...filters }, machine, now)).map((e) => [mine, theirs, onMachine, later].indexOf(e))

  test('who made it, where it is kept, how long; temporary takes the soon ones too', () => {
    expect(pick({ who: 'u2' })).toEqual([1, 3])
    expect(pick({ where: 'cloud' })).toEqual([0, 1, 3])
    expect(pick({ where: 'GF server' })).toEqual([2])
    expect(pick({ keep: 'kept' })).toEqual([1])
    expect(pick({ keep: 'soon' })).toEqual([0])
    expect(pick({ keep: 'temporary' })).toEqual([0, 3])
    expect(pick({ who: 'u1', keep: 'temporary' })).toEqual([0])
    expect([keptAs(mine, now), keptAs(onMachine, now), whereOf(onMachine, machine)]).toEqual(['soon', null, 'GF server'])
  })

  test('images and videos open as a grid; a picture is read only for an image with a cloud copy, of a size worth it', () => {
    expect([defaultView('media'), defaultView('all'), defaultView('docs')]).toEqual(['grid', 'list', 'list'])
    const image = { type: 'binary', contentType: 'image/png', size: 3000 }
    expect(wantsThumb(image)).toBe(true)
    expect(wantsThumb({ ...image, storedOn: { machine: 'GF server' } }), 'reading it would upload it').toBe(false)
    expect(wantsThumb({ ...image, storedOn: { machine: 'GF server' }, keep: { expiresAt: '2026-11-04T00:00:00Z', mine: true } }), 'its temporary cloud copy is read').toBe(true)
    expect(wantsThumb({ ...image, size: 50 * 1024 * 1024 })).toBe(false)
    expect(wantsThumb({ ...image, contentType: 'image/svg+xml' })).toBe(false)
    expect(wantsThumb({ ...image, contentType: 'video/mp4' })).toBe(false)
  })
})
