// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { MAX_HELD_IDS } from '../../../../apps/desktop/src/session/shared/extensions/coalesced-reads'
import { until } from '../../../support/awaitCondition'

/**
 * #7257, the phone's half: a watched chat's files changing reach the page as those files — `{ kind: 'entries', entries,
 * gone }`, read with the person's token — never a `resync` that has the page list the chat again. While a read is on its
 * way, the ids named meanwhile wait for it and go in exactly one more. The database is a fake that records each `in()`.
 */

const ORIGIN = 'https://board.acct.apps.gugu.invalid'
const CHAT = '0b000000-0000-4000-8000-000000007257'
const OTHER_CHAT = '0b000000-0000-4000-8000-000000007258'
const [A, B, C] = ['0f000000-0000-4000-8000-00000000000a', '0f000000-0000-4000-8000-00000000000b', '0f000000-0000-4000-8000-00000000000c']
const auth = vi.hoisted(() => ({ token: `h.${Buffer.from(JSON.stringify({ sub: '0a000000-0000-4000-8000-000000007257' })).toString('base64url')}.s` }))
/**
 * Each read of the named files — the door's reads started together (one `workspace_get_as` per id, in one go) are one read:
 * its ids; the chat's lists; a way to hold a read open until the test lets it answer; reads to fail.
 */
const db = vi.hoisted(() => ({ reads: [] as string[][], lists: 0, hold: null as Promise<void> | null, fail: 0, openingName: 'a.md' }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => auth.token }))
vi.mock('@gugu/core/cloud/supabase', () => {
  let open: { ids: string[]; fail: boolean } | null = null
  const read = () => {
    if (!open) {
      open = { ids: [], fail: db.fail > 0 }
      if (open.fail) db.fail -= 1
      db.reads.push(open.ids)
      queueMicrotask(() => (open = null))
    }
    return open
  }
  const row = (id: string, filename: string) => ({ id, chat_id: id === C ? OTHER_CHAT : CHAT, filename, version: 5, content_type: filename.endsWith('.mp4') ? 'video/mp4' : 'text/plain', size_bytes: 3276, parent_id: null, system_role: null, path: filename })
  return {
    createGuguSupabaseClient: () => ({
      from: () => {
        const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { id: CHAT }, error: null }) }
        return query
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null }
        // Every file of the chat: A.
        if (name === 'workspace_list_as') {
          db.lists += 1
          return { data: [row(A, 'a.md')], error: null }
        }
        // B is gone; A and C are files (C of another chat: gone for this one too).
        const id = String(args.p_item_id)
        const batch = read()
        batch.ids.push(id)
        batch.ids.sort()
        if (db.hold) await db.hold
        if (batch.fail) return { data: null, error: { message: 'offline' } }
        if (id === B) return { data: null, error: { message: `workspace item not found: ${id}`, hint: 'workspace_item_not_found' } }
        return { data: [row(id, db.openingName === 'a.md' ? `${id.slice(-1)}.md` : db.openingName)], error: null }
      },
    }),
  }
})

const activation = Object.getOwnPropertyDescriptor(navigator, 'userActivation')
const opened = vi.fn()
const peeked = vi.fn()
let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
beforeEach(() => {
  db.reads.length = 0
  db.lists = 0
  db.hold = null
  db.fail = 0
  db.openingName = 'a.md'
  opened.mockClear()
  peeked.mockClear()
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  host = hostAppFrame(
    frame,
    { extensionId: 'board', tabId: 'tab-1', chatId: CHAT, capabilities: ['files:read'], locale: 'en-US', themeMode: 'light' },
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: opened, peek: peeked, chrome: vi.fn() },
  )
})
afterEach(() => {
  host?.dispose()
  host = undefined
  frame.remove()
  if (activation) Object.defineProperty(navigator, 'userActivation', activation)
  else Reflect.deleteProperty(navigator, 'userActivation')
})

let nextId = 1
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await until(`the host answered ${method}`, () => posted.mock.calls.some(([message]) => (message as { id?: number }).id === id))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}
const changes = () =>
  posted.mock.calls.map(([message]) => message as { t?: string; event?: { type: string; change: unknown } })
    .filter((message) => message.t === 'event' && message.event?.type === 'filesChanged').map((message) => message.event!.change)

describe('a watched chat\'s files changed: the page hears those files (#7257)', () => {
  it('the named files as they are now and the ids not there — one read; an unwatched chat, nothing', async () => {
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    await host!.filesChanged([{ chatId: CHAT, itemIds: [A, B, C] }, { chatId: OTHER_CHAT, itemIds: [A] }])
    expect(db.reads).toEqual([[A, B, C]])
    expect(changes()).toEqual([{ kind: 'entries', entries: [expect.objectContaining({ id: A, chat: CHAT, name: 'a.md', version: 5 })], gone: [B, C] }])
  }, 60_000)

  it('ids named while a read is on its way wait for it, and go together in exactly one more', async () => {
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    let release!: () => void
    db.hold = new Promise<void>((resolve) => (release = resolve))
    const first = host!.filesChanged([{ chatId: CHAT, itemIds: [A] }])
    await until('the first read is on its way', () => db.reads.length === 1)
    const second = host!.filesChanged([{ chatId: CHAT, itemIds: [B] }])
    const third = host!.filesChanged([{ chatId: CHAT, itemIds: [C, B] }])
    expect(db.reads).toEqual([[A]])
    db.hold = null
    release()
    await Promise.all([first, second, third])
    expect(db.reads).toEqual([[A], [B, C]])
    expect(JSON.stringify(changes())).not.toContain('resync')
  }, 60_000)

  it('a read that fails twice: its files go with the next ones named, so the page is not left on the old ones', async () => {
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    db.fail = 2
    await host!.filesChanged([{ chatId: CHAT, itemIds: [A] }])
    expect(db.reads).toEqual([[A], [A]])
    expect(changes()).toEqual([])
    await host!.filesChanged([{ chatId: CHAT, itemIds: [B] }])
    expect(db.reads).toEqual([[A], [A], [A, B]])
    expect(changes()).toEqual([{ kind: 'entries', entries: [expect.objectContaining({ id: A })], gone: [B] }])
  }, 60_000)

  it('more ids kept than a read names one by one: one list of the chat, and a kept id not in it said gone', async () => {
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    const kept = Array.from({ length: MAX_HELD_IDS }, (_, i) => `0f000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    db.fail = 2
    await host!.filesChanged([{ chatId: CHAT, itemIds: kept }])
    expect(db.reads).toEqual([[...kept].sort(), [...kept].sort()])
    // One more named: past the cap — the chat listed once, not read id by id; every id still said (#7257 review 2).
    await host!.filesChanged([{ chatId: CHAT, itemIds: [B] }])
    expect(db.reads).toHaveLength(2)
    expect(db.lists).toBe(1)
    expect(changes()).toEqual([{ kind: 'entries', entries: [expect.objectContaining({ id: A, name: 'a.md' })], gone: [...kept, B] }])
  }, 60_000)

  it('the page stops hearing the chat: what was kept for it goes', async () => {
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    db.fail = 2
    await host!.filesChanged([{ chatId: CHAT, itemIds: [A] }])
    expect(await call('filesWatch', { place: { chat: CHAT }, on: false })).toMatchObject({ ok: true })
    expect(await call('filesWatch', { place: { chat: CHAT } })).toMatchObject({ ok: true })
    await host!.filesChanged([{ chatId: CHAT, itemIds: [B] }])
    expect(db.reads).toEqual([[A], [A], [B]])
  }, 60_000)
})


describe('the phone openWith bridge hands unclaimed files to the host preview (#7663)', () => {
  it.each([false, true])('ordinary and peek openings carry the same file metadata (peek=%s)', async (peek) => {
    db.openingName = 'clip.mp4'
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } })
    const result = await call('filesOpenWith', { ref: { id: A }, ...(peek ? { peek: true } : {}) })
    expect(result).toMatchObject({ ok: true })
    const detail = { chatId: CHAT, itemId: A, name: 'clip.mp4', choice: { kind: 'none' }, file: { document: false, contentType: 'video/mp4', version: 5, size: 3276 } }
    if (peek) {
      expect(peeked).toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat', detail: expect.objectContaining(detail) }))
      expect(opened).not.toHaveBeenCalled()
    } else {
      expect(opened).toHaveBeenCalledWith(expect.objectContaining(detail))
      expect(peeked).not.toHaveBeenCalled()
    }
  })
})
