// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openGroupFile } from '../../../../apps/desktop/src/components/markdown/fileLinks'
import { GROUP_FILE_OPEN_EVENT, type GroupFileOpenDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { until } from '../../../support/awaitCondition'

/**
 * #7257 (review 2, point 5): two file links clicked one after the other — each first reads which chat its file is in, and
 * those reads come back in either order. The chat shell is asked to open only the one clicked last. Each read is held
 * until the test lets it go.
 */

const [A, B] = ['aaaaaaaa-bbbb-4ccc-8ddd-00000000000a', 'aaaaaaaa-bbbb-4ccc-8ddd-00000000000b']
const held = vi.hoisted(() => new Map<string, () => void>())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const query = (id = '') => ({
    select: () => query(id),
    eq: (_key: string, value: string) => query(value),
    maybeSingle: () => new Promise((done) => held.set(id, () => done({ data: { chat_id: 'chat-1' }, error: null }))),
  })
  return { chatDb: { from: () => query() } }
})

const seen: string[] = []
const take = (event: Event) => {
  seen.push((event as CustomEvent<GroupFileOpenDetail>).detail.itemId)
  event.preventDefault()
}
beforeEach(() => {
  held.clear()
  seen.length = 0
  window.addEventListener(GROUP_FILE_OPEN_EVENT, take)
})
afterEach(() => window.removeEventListener(GROUP_FILE_OPEN_EVENT, take))

/** A pill's link clicked: settles when it has been opened (or not). */
const click = (itemId: string) => openGroupFile(itemId, { slide: '1' })

describe('two file links clicked one after the other: the second is opened (#7257)', () => {
  it('B\'s chat read first, then A\'s: only B is opened — A, back later, says nothing', async () => {
    const a = click(A)
    await until('A is asked', () => held.has(A))
    const b = click(B)
    await until('B is asked', () => held.has(B))
    held.get(B)!()
    expect(await b).toBe(true)
    held.get(A)!()
    expect(await a, 'nothing to tell the person').toBe(true)
    expect(seen, '对照:父提交两个都开，后到的 A 盖住 B').toEqual([B])
  }, 30_000)

  it('A\'s read back first: A is no longer the latest click by then — only B', async () => {
    const a = click(A)
    await until('A is asked', () => held.has(A))
    const b = click(B)
    await until('B is asked', () => held.has(B))
    held.get(A)!()
    await a
    held.get(B)!()
    await b
    expect(seen).toEqual([B])
  }, 30_000)

  it('control: one click alone is opened', async () => {
    const a = click(A)
    await until('A is asked', () => held.has(A))
    held.get(A)!()
    expect(await a).toBe(true)
    expect(seen).toEqual([A])
  }, 30_000)
})
