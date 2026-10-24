// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost'
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { fileIconKey } from '../../../../apps/desktop/src/session/shared/extensions/app-icon'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { installedExtensionsStore, type InstalledExtensionsList } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { until } from '../../../support/awaitCondition'

/**
 * owner 10-17, the phone's half: a chat file's mark is the icon its App declared for that kind of file (`fileIcons`, kept
 * by `fileIconKey` beside the tab icons this page re-encoded) — a claim without one has none, never the tab's own icon.
 * Read through the page's own door: the chat's files changing reach it as entries, each with its `claimedBy`.
 * (Control: the parent commit, where both rows below carry the tab icon.)
 */

const ORIGIN = 'https://workspace.acct.apps.gugu.invalid'
const { CHAT, MD, JSON_FILE } = vi.hoisted(() => ({
  CHAT: '0b000000-0000-4000-8000-000000001017', MD: '0f000000-0000-4000-8000-00000000000a', JSON_FILE: '0f000000-0000-4000-8000-00000000000b',
}))
const auth = vi.hoisted(() => ({ token: `h.${Buffer.from(JSON.stringify({ sub: '0a000000-0000-4000-8000-000000001017' })).toString('base64url')}.s` }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => auth.token }))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => {
    const rows = [
      { id: MD, chat_id: CHAT, kind: 'document', filename: 'notes.md', content_type: 'text/markdown', version: 1 },
      { id: JSON_FILE, chat_id: CHAT, kind: 'document', filename: 'cfg.json', content_type: 'application/json', version: 1 },
    ]
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: { id: CHAT }, error: null }),
    }
    // The folder's doors, as the person: a file by its id, the chat's list, who may delete what (everyone, everything).
    const placed = (row: (typeof rows)[number]) => ({ ...row, parent_id: null, system_role: null, path: row.filename })
    const rpc = async (name: string, args: Record<string, unknown>) => {
      if (name === 'chat_facts') return { data: [{ id: args.p_chat_id, kind: 'group', source_chat_id: null }], error: null };
  if (name === 'workspace_deletable_as') return { data: args.p_item_ids, error: null }
      if (name === 'workspace_list_as') return { data: rows.map(placed), error: null }
      const row = rows.find((candidate) => candidate.id === args.p_item_id)
      return row ? { data: [placed(row)], error: null } : { data: null, error: { message: 'workspace item not found', hint: 'workspace_item_not_found' } }
    }
    return { from: () => query, rpc }
  },
}))

const workspace = parseExtensionManifest({
  id: 'workspace', name: '文件夹', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: '文件夹', icon: 'icon.png', opensFiles: { chat: ['.md', '.json'] }, fileIcons: { '.md': 'md.png' } }] },
})

let frame: HTMLIFrameElement
let posted: ReturnType<typeof vi.fn>
let host: ReturnType<typeof hostAppFrame> | undefined
beforeEach(() => {
  installedExtensionsStore.applyList({
    extensions: [workspace], invalid: [],
    icons: { 'workspace.main': 'data:tab-icon', [fileIconKey('workspace.main', '.md')]: 'data:md-icon' },
  } as unknown as InstalledExtensionsList)
  frame = document.createElement('iframe')
  frame.src = `${ORIGIN}/index.html`
  document.body.appendChild(frame)
  posted = vi.fn()
  Object.defineProperty(frame.contentWindow!, 'postMessage', { value: posted, configurable: true })
  host = hostAppFrame(
    frame,
    { extensionId: 'workspace', tabId: 'tab-1', chatId: CHAT, capabilities: ['files:read'], locale: 'en-US', themeMode: 'light' },
    { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome: vi.fn() },
  )
})
afterEach(() => {
  host?.dispose()
  host = undefined
  frame.remove()
})

let nextId = 1
async function call(method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = nextId++
  window.dispatchEvent(new MessageEvent('message', { data: { m: APP_FRAME_MARKER, t: 'call', id, method, args }, source: frame.contentWindow, origin: ORIGIN }))
  await until(`the host answered ${method}`, () => posted.mock.calls.some(([message]) => (message as { id?: number }).id === id))
  return posted.mock.calls.map(([message]) => message as Record<string, unknown>).find((message) => message.id === id)!
}

describe('a chat file\'s icon on the phone: the one its App declared for its kind (owner 10-17)', () => {
  it('a declared kind carries that icon; a claimed kind without one carries none — not the tab\'s icon', async () => {
    expect(await call('filesWatch', { watchId: 'source-watch', place: { chat: CHAT } })).toMatchObject({ ok: true })
    await host!.filesChanged([{ chatId: CHAT, itemIds: [MD, JSON_FILE] }])
    const change = posted.mock.calls.map(([m]) => m as { t?: string; event?: { type: string; change: { entries: { id: string; claimedBy: unknown }[] } } })
      .find((m) => m.t === 'event' && m.event?.type === 'filesChanged')!.event!.change
    const byId = Object.fromEntries(change.entries.map((entry) => [entry.id, entry.claimedBy]))
    expect(byId[MD]).toEqual({ id: 'workspace', name: '文件夹', icon: 'data:md-icon' })
    expect(byId[JSON_FILE]).toEqual({ id: 'workspace', name: '文件夹', icon: null })
  }, 60_000)
})
