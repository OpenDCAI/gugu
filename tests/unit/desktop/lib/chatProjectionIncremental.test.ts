// @vitest-environment node
// @@@incremental-list: re-assembling only the touched conversations gives exactly the list a full assemble gives.
import { describe, expect, it } from 'vitest'
import {
  assemble, entityKey, membershipId, mergeCells, missingDependencies, reassemble, sortMembers, splitKey, splitMembershipId, touchedChats,
  type AssembleSource, type Cell, type ChatValue, type EntityKey, type EntityValue, type MembershipValue, type ProjectionCache,
} from '../../../../apps/desktop/src/lib/chatProjectionAlgebra'

const viewer = 'me'
const t = (minute: number) => `2026-11-02T10:${String(minute).padStart(2, '0')}:00Z`
const chat = (id: string, kind: 'group' | 'dm', minute: number): ChatValue => ({ id, public_id: null, kind, status: 'active', name: kind === 'group' ? id : null,
  avatar_url: null, created_at: t(0), last_message_at: t(minute), last_message_preview: `p-${id}`, next_message_seq: 2, pinned_message_id: null,
  source_chat_id: null, source_message_id: null })
const member = (chatId: string, userId: string): MembershipValue => ({ chat_id: chatId, user_id: userId, last_read_seq: 0, is_marked_unread: false, version: 1,
  notification_level: 'all', is_pinned: false, updated_at: t(0), joined_at: t(0), inbox_published: true, role: 'member' })
const identity = (id: string) => ({ id, display_name: id, type: 'agent' })
const cells = (stamp: string, entries: Array<[EntityKey, EntityValue | null]>): Array<[EntityKey, Cell]> =>
  entries.map(([key, value]) => [key, { value, stamp }])

/** The cache read the way the projection owner reads it (members scanned here; the owner keeps an index). */
function sourceOf(cache: ProjectionCache): AssembleSource {
  return {
    value: <T extends EntityValue>(family: Parameters<typeof entityKey>[0], id: string) => (cache.get(entityKey(family, id))?.value ?? undefined) as T | undefined,
    members: (chatId) => sortMembers([...cache].flatMap(([key, cell]) => {
      const { family, id } = splitKey(key)
      return family === 'membership' && cell.value && splitMembershipId(id).chatId === chatId ? [cell.value as MembershipValue] : []
    })),
  }
}
const chatsOf = (cache: ProjectionCache) => (userId: string) => [...cache].flatMap(([key, cell]) => {
  const { family, id } = splitKey(key)
  return family === 'membership' && cell.value && splitMembershipId(id).userId === userId ? [splitMembershipId(id).chatId] : []
})

const base = mergeCells(new Map(), cells('1', [
  [entityKey('identity', viewer), identity(viewer)], [entityKey('identity', 'a1'), identity('a1')], [entityKey('identity', 'a2'), identity('a2')],
  ...(['g1', 'g2', 'd1'] as const).flatMap((id, n): Array<[EntityKey, EntityValue | null]> => [
    [entityKey('chat', id), chat(id, id.startsWith('g') ? 'group' : 'dm', n + 1)],
    [entityKey('membership', membershipId(id, viewer)), member(id, viewer)],
    [entityKey('preview', id), null], [entityKey('unread', id), null],
    ...(id.startsWith('g') ? [[entityKey('override', `group/${id}`), null] as [EntityKey, null]] : []),
  ]),
  [entityKey('membership', membershipId('g1', 'a1')), member('g1', 'a1')], [entityKey('membership', membershipId('g2', 'a1')), member('g2', 'a1')],
  [entityKey('membership', membershipId('g2', 'a2')), member('g2', 'a2')], [entityKey('membership', membershipId('d1', 'a2')), member('d1', 'a2')],
  [entityKey('override', 'a2'), null],
]))

describe('reassemble = assemble', () => {
  const cases: Array<[string, Array<[EntityKey, EntityValue | null]>]> = [
    ['a new message moves its conversation to the top', [[entityKey('preview', 'g1'), { chat_id: 'g1', created_at: t(30), preview: 'hi', failure: null }]]],
    ['my membership is revoked', [[entityKey('membership', membershipId('g2', viewer)), null]]],
    ['a peer alias changes', [[entityKey('override', 'a2'), { alias: 'Bob' }]]],
    ['a member identity disappears', [[entityKey('identity', 'a1'), null]]],
    ['a group alias changes', [[entityKey('override', 'group/g2'), { alias: 'team' }]]],
  ]
  for (const [name, change] of cases) it(name, () => {
    const before = assemble(base, viewer)
    const next = mergeCells(base, cells('2', change))
    const incremental = reassemble(before, touchedChats(change.map(([key]) => key), chatsOf(next)), sourceOf(next), viewer)
    expect(incremental).toEqual(assemble(next, viewer))
  })
})

it('a wave asks only about the keys it settled, and finds what the full scan finds for them', () => {
  const added: Array<[EntityKey, EntityValue | null]> = [[entityKey('membership', membershipId('g3', viewer)), member('g3', viewer)],
    [entityKey('membership', membershipId('g3', 'a9')), member('g3', 'a9')]]
  const next = mergeCells(base, cells('2', added))
  expect(missingDependencies(next, viewer, added.map(([key]) => key))).toEqual(missingDependencies(next, viewer))
  expect(missingDependencies(next, viewer, added.map(([key]) => key))).toEqual([entityKey('chat', 'g3'), entityKey('identity', 'a9')].sort())
})

it('checks a settled wave without iterating unrelated cache entries', () => {
  const cache = new Map(base)
  cache[Symbol.iterator] = () => { throw new Error('whole-cache iteration') }
  cache.keys = () => { throw new Error('whole-cache keys') }
  expect(missingDependencies(cache, viewer, [entityKey('chat', 'g1')])).toEqual([])
})

it('closes a peer alias when the chat settles after its membership wave', () => {
  const cache = mergeCells(new Map(), cells('1', [
    [entityKey('identity', viewer), identity(viewer)],
    [entityKey('identity', 'peer'), identity('peer')],
    [entityKey('membership', membershipId('new', viewer)), member('new', viewer)],
    [entityKey('membership', membershipId('new', 'peer')), member('new', 'peer')],
    [entityKey('chat', 'new'), chat('new', 'dm', 1)],
    [entityKey('preview', 'new'), null], [entityKey('unread', 'new'), null],
  ]))
  expect(missingDependencies(cache, viewer, [entityKey('chat', 'new')], sourceOf(cache).members)).toEqual([entityKey('override', 'peer')])
})

it.each([10, 100, 1000])('assembles one changed row with the same cell-read budget among %i chats', (size) => {
  const rows = Array.from({ length: size }, (_, index) => ({ ...assemble(base, viewer)[0]!, id: `g${index}` }))
  const source = sourceOf(base)
  let reads = 0
  const counted: AssembleSource = {
    value: (family, id) => { reads += 1; return source.value(family, id) },
    members: source.members,
  }
  const next = reassemble(rows, new Set(['g1']), counted, viewer)
  expect(next.find(row => row.id === 'g1')).toEqual(assemble(base, viewer).find(row => row.id === 'g1'))
  expect(next.find(row => row.id === 'g0')).toBe(rows[0])
  expect(reads).toBe(7)
})
