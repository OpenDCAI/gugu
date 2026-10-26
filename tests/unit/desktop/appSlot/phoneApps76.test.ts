import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appOrigin } from '../../../../apps/desktop/src/components/appSlot/appOrigin'
import { extensionContentSecurityPolicy } from '../../../../apps/desktop/src/session/shared/extensions/app-csp'
import { APP_RUNTIME_FORGET_PAGE, RUNTIME_SCRIPT_TAG } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { fileIconKey } from '../../../../apps/desktop/src/session/shared/extensions/app-icon'

// L9 (摩擦单 F76): the phone's App store (phoneApps.ts) — install, update, uninstall, re-tag, where an App's page is,
// and its data. The shell's plugin is played here by a map with the Java side's semantics (GuguAppStorePlugin: files
// under <id>@<version>, data under <app>, an App's data removed whole); the real one is measured on the emulator
// (evidence 2026-09-30-l9-mobile-apps, M-cells). What an App keeps is the phone's, whoever is signed in (主人 10-01):
// the cells that switch the signed-in account (`shell.token`, what the page read before) find the same storage.

const SHELL = 'https://localhost'
const SUPABASE = 'https://db.example.test'
const ALICE_UPLOADER = '11111111-2222-4333-8444-555555555555'
const MALLORY_UPLOADER = '99999999-8888-4777-8666-555555555555'
const ALICE = '0a000000-0000-4000-8000-00000000000a'
const BOB = '0b000000-0000-4000-8000-00000000000b'
const OLD_TAG = '<script src="/_gugu/0/gugu.js"></script>'

const shell = vi.hoisted(() => ({
  versions: new Map<string, Map<string, Uint8Array>>(),
  stages: new Map<string, Map<string, Uint8Array>>(),
  data: new Map<string, string>(),
  index: null as string | null,
  /** The forget pages opened (forget-entry.ts, one per origin), and whether they answer. */
  forgotten: [] as string[],
  forgetAnswers: true,
  dataRemoved: [] as string[],
  token: null as string | null,
  shipped: [] as unknown[],
  packages: new Map<string, Uint8Array>(),
  lists: [] as { extensions: { id: string; version: string }[]; origins: Record<string, string>; disabled: string[]; autoUpdateOff: string[]; publishers: Record<string, { id: string; name: string }> }[],
  asked: [] as { installed: { version: string } | undefined; manifest: { version: string } }[],
  answer: 'confirmed' as 'confirmed' | 'declined',
  /** The App market as the shell reads it (GuguAppStore.marketRead → the download site): path → bytes, and every read. */
  market: new Map<string, Uint8Array>(),
  marketReads: [] as string[],
  /** The cap each market read was asked with (GuguAppStore.marketRead's `maxBytes`; none: the shell's own). */
  marketCaps: [] as (number | undefined)[],
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({
    async stage({ stage, path, base64 }: { stage: string; path: string; base64: string }) {
      const files = shell.stages.get(stage) ?? new Map<string, Uint8Array>()
      files.set(path, new Uint8Array(Buffer.from(base64, 'base64')))
      shell.stages.set(stage, files)
    },
    async commit({ stage, dir }: { stage: string; dir: string }) {
      shell.versions.set(dir, shell.stages.get(stage)!)
      shell.stages.delete(stage)
    },
    async discard(args: { stage?: string; dir?: string }) {
      if (args.stage) shell.stages.delete(args.stage)
      if (args.dir) shell.versions.delete(args.dir)
    },
    async list() {
      return { dirs: [...shell.versions.keys()], stages: shell.stages.size }
    },
    async readText({ dir, path }: { dir: string; path: string }) {
      return { text: Buffer.from(shell.versions.get(dir)!.get(path)!).toString('utf8') }
    },
    async writeText({ dir, path, text }: { dir: string; path: string; text: string }) {
      shell.versions.get(dir)!.set(path, new Uint8Array(Buffer.from(text, 'utf8')))
    },
    async readIndex() {
      return { json: shell.index }
    },
    async marketRead({ path, maxBytes }: { path: string; maxBytes?: number }) {
      shell.marketReads.push(path)
      shell.marketCaps.push(maxBytes)
      const bytes = shell.market.get(path)
      if (!bytes) throw new Error(`HTTP 404 for ${path}`)
      // As DownloadSite.read: over the cap, it stops while the bytes come and says so.
      if (maxBytes && bytes.byteLength > maxBytes) throw new Error(`${path} is larger than ${maxBytes} bytes`)
      return { base64: Buffer.from(bytes).toString('base64') }
    },
    async writeIndex({ json }: { json: string }) {
      shell.index = json
    },
    async dataRead({ app, path }: { app: string; path: string }) {
      return { text: shell.data.get(`${app}/${path}`) ?? null }
    },
    async dataWrite({ app, path, text }: { app: string; path: string; text: string }) {
      shell.data.set(`${app}/${path}`, text)
    },
    async dataList({ app }: { app: string; path: string }) {
      const prefix = `${app}/`
      const entries = [...shell.data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ path: key.slice(prefix.length), kind: 'file' as const }))
      return { entries }
    },
    async dataRemove({ app }: { app: string }) {
      shell.dataRemoved.push(app)
      for (const key of [...shell.data.keys()]) if (key.startsWith(`${app}/`)) shell.data.delete(key)
    },
  }),
}))
vi.mock('@gugu/core/cloud/config', () => ({ getSupabaseUrl: () => SUPABASE }))
// An icon as this page re-encodes it: the bytes' first letters stand in for the PNG it would draw (no canvas here).
const blobs = vi.hoisted(() => new Map<string, Blob>())
vi.mock('../../../../apps/desktop/src/lib/redrawImage', () => ({ redrawImage: async (url: string) => `png:${await blobs.get(url)!.text()}` }))
// #7290 A card is installed by its message: the phone reads it (chatDb, as the person) — the publisher the server wrote on
// it — and signs its bytes (attachments/urls): here, the card's row and its package as `publish` put them up.
const cards = vi.hoisted(() => new Map<string, { row: Record<string, unknown>; url: string }>())
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: {
    from: () => {
      let id = ''
      const query = { select: () => query, eq: (_column: string, value: string) => ((id = value), query), maybeSingle: async () => ({ data: cards.get(id)?.row ?? null, error: null }) }
      return query
    },
  },
}))
vi.mock('../../../../apps/desktop/src/lib/attachmentBytes', () => ({
  attachmentResolver: {
    resolve: async (source: { kind: string; itemId?: string }) => {
      const card = [...cards.values()].find((entry) => entry.row.file_item_id === source.itemId)
      return card ? { status: 'ready', url: card.url } : { status: 'gone' }
    },
  },
}))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({
  rendererLogger: () => ({ error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined }),
}))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => shell.token }))
// Every uploader here is a person, so the publisher is the uploader, named as the directory names them (app-identity.ts).
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: string[]) =>
    ids.map((id) => ({ id, type: 'human', owner_user_id: null, display_name: id.startsWith('1111') ? 'Alice' : 'Mallory' })),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { applyList: (list: (typeof shell.lists)[number]) => shell.lists.push(list) },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/install-consent', () => ({
  installConsentPrompt: (request: (typeof shell.asked)[number]) => request,
  askInShell: async (prompt: (typeof shell.asked)[number]) => {
    shell.asked.push(prompt)
    return { outcome: shell.answer }
  },
}))

function jwt(sub: string): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part({ sub, exp: 4_102_444_800 })}.x`
}

function manifest(id: string, version: string, capabilities: string[] = []) {
  return { id, name: id === 'vote' ? 'Vote' : 'Workspace', version, apiVersion: EXTENSION_API_VERSION, platforms: ['desktop', 'phone'], entry: 'index.html', permissions: { capabilities }, contributes: { tabs: [{ name: 'main', title: 'Main' }] } }
}

/** A card carrying a package `uploader` published: two pages, a script, a data file. Its message id. */
async function publish(id: string, version: string, uploader = ALICE_UPLOADER, capabilities: string[] = []): Promise<string> {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(manifest(id, version, capabilities)))
  zip.file('index.html', `<!doctype html><title>${version}</title><script src="app.js"></script>`)
  zip.file('more/page.html', '<p>second page</p>')
  zip.file('app.js', `document.title = '${version}'`)
  zip.file('seed.json', '{"options":[]}')
  const url = `https://cdn.example.test/${uploader}/${id}-${version}.guguext`
  shell.packages.set(url, await zip.generateAsync({ type: 'uint8array' }))
  const messageId = `m-${cards.size + 1}`
  cards.set(messageId, {
    url,
    row: {
      id: messageId,
      content: `[附件] ${id}-${version}.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file`,
      file_item_id: `item-${messageId}`,
      file_version: 1,
      file_blob_id: null,
      sender_user_id: uploader,
    },
  })
  return messageId
}

const text = (dir: string, path: string) => Buffer.from(shell.versions.get(dir)!.get(path)!).toString('utf8')
const index = () => JSON.parse(shell.index ?? '{}') as { installed: Record<string, { dir: string; runtimeTag: string }>; serve: Record<string, { root: string; csp: string }> }
const lastList = () => shell.lists[shell.lists.length - 1]!

/** The page as it starts: a fresh module, reading what the shell kept (as after the phone restarts). */
async function start() {
  vi.resetModules()
  return (await import('../../../../apps/desktop/src/components/appSlot/phoneApps')).phoneApps
}

beforeEach(() => {
  shell.versions.clear()
  shell.stages.clear()
  shell.data.clear()
  shell.index = null
  shell.forgotten = []
  shell.forgetAnswers = true
  shell.dataRemoved = []
  shell.token = jwt(ALICE)
  shell.shipped = [manifest('workspace', '1.0.0')]
  shell.packages.clear()
  shell.lists = []
  shell.asked = []
  shell.answer = 'confirmed'
  shell.market.clear()
  shell.marketReads = []
  shell.marketCaps = []
  vi.stubGlobal('__APP_VERSION__', '0.2.60')
  const kept = new Map<string, string>()
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => kept.set(key, value) }
  // The forget page in an origin (forget-entry.ts), played here: its frame is appended, "loads", and says it forgot.
  // The window and document are only as much of a page as the modules imported here touch.
  const page = Object.assign(new EventTarget(), { localStorage: storage })
  vi.stubGlobal('window', page)
  vi.stubGlobal('document', {
    documentElement: { lang: '' },
    createElement: () => ({ hidden: false, src: '', contentWindow: {}, setAttribute: () => undefined, remove: () => undefined }),
    body: {
      append(frame: { src: string; contentWindow: object }) {
        shell.forgotten.push(frame.src)
        const origin = new URL(frame.src).origin
        if (shell.forgetAnswers) queueMicrotask(() => page.dispatchEvent(Object.assign(new Event('message'), { source: frame.contentWindow, origin })))
      },
    },
  })
  vi.stubGlobal('location', { origin: SHELL })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('fetch', async (url: string) => {
    if (url === '/apps/index.json') return new Response(JSON.stringify(shell.shipped))
    const bytes = shell.packages.get(url)
    return bytes ? new Response(bytes as Uint8Array<ArrayBuffer>) : new Response('', { status: 404 })
  })
})

describe('U3 the phone App store: install, update, uninstall, re-tag', () => {
  it('installs a package that asks for nothing without asking, under <id>@<version>, every page given the runtime line', async () => {
    const apps = await start()
    const result = await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })

    expect(result).toMatchObject({ success: true, data: { installed: true, outcome: 'confirmed', id: 'vote', version: '1.0.0' } })
    expect(shell.asked).toEqual([])
    expect([...shell.versions.keys()]).toEqual(['vote@1.0.0'])
    for (const page of ['index.html', 'more/page.html']) expect(text('vote@1.0.0', page).split(RUNTIME_SCRIPT_TAG)).toHaveLength(2)
    // After the doctype, before the App's own script (injectAppRuntime).
    expect(text('vote@1.0.0', 'index.html')).toBe(`<!doctype html>${RUNTIME_SCRIPT_TAG}<title>1.0.0</title><script src="app.js"></script>`)
    expect(text('vote@1.0.0', 'app.js')).toBe("document.title = '1.0.0'")
    expect(index().serve.vote).toEqual({ root: 'file:vote@1.0.0', csp: extensionContentSecurityPolicy(SHELL, []) })
    // The one store the card, the group's panel and 「用 X 打开」 read on both platforms.
    expect(lastList().extensions.map((app) => app.id)).toEqual(['workspace', 'vote'])
    expect(lastList().origins).toEqual({ workspace: 'preinstalled', vote: 'attachment' })
    expect(lastList().publishers.vote).toEqual({ id: ALICE_UPLOADER, name: 'Alice' })
  })

  it('updates in place when the new version asks for nothing new; the older version goes at the next start', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    const update = await apps.installAttachment({ messageId: await publish('vote', '1.1.0') })

    expect(update).toMatchObject({ success: true, data: { installed: true, version: '1.1.0', updatedFrom: '1.0.0' } })
    expect(shell.asked).toEqual([])
    expect(index().installed.vote!.dir).toBe('vote@1.1.0')
    expect(index().serve.vote!.root).toBe('file:vote@1.1.0')

    await (await start()).ready()
    expect([...shell.versions.keys()]).toEqual(['vote@1.1.0'])
  })

  it('asks about what an update newly asks for — declined, nothing changes', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    shell.answer = 'declined'
    const update = await apps.installAttachment({ messageId: await publish('vote', '1.2.0', ALICE_UPLOADER, ['chat:relay']) })

    expect(update).toMatchObject({ success: true, data: { installed: false, outcome: 'declined' } })
    expect(shell.asked.map((ask) => [ask.installed?.version, ask.manifest.version])).toEqual([['1.0.0', '1.2.0']])
    expect(index().installed.vote!.dir).toBe('vote@1.0.0')
  })

  // Phones now read and control App-owned agents on computers; consent must say so.
  it('asks about phone-supported App agent reads, control and chat relay', async () => {
    const apps = await start()
    const quiet = await apps.installAttachment({ messageId: await publish('vote', '1.0.0', ALICE_UPLOADER, ['agents:read']) })
    expect(quiet).toMatchObject({ success: true, data: { installed: true, outcome: 'confirmed' } })
    expect(shell.asked).toHaveLength(1)

    await apps.installAttachment({ messageId: await publish('board', '1.0.0', ALICE_UPLOADER, ['agents:control', 'chat:relay']) })
    const asked = shell.asked as unknown as { manifest: { permissions?: { capabilities?: string[] } } }[]
    expect(asked.map((ask) => ask.manifest.permissions?.capabilities)).toEqual([['agents:read'], ['agents:control', 'chat:relay']])
    // What is kept is the App as it was written: a computer reading the same package asks about all of it.
    const kept = index().installed.board as unknown as { manifest: { permissions: { capabilities: string[] } } }
    expect(kept.manifest.permissions.capabilities).toEqual(['agents:control', 'chat:relay'])
  })

  it('refuses a phone declaration requiring an unavailable human capability before consent', async () => {
    const apps = await start()
    const refused = await apps.installAttachment({ messageId: await publish('vote', '1.0.0', ALICE_UPLOADER, ['notifications']) })
    expect(refused).toMatchObject({ success: false, error: expect.stringContaining('phone does not support notifications') })
    expect(shell.asked).toEqual([])
    expect(index().installed.vote).toBeUndefined()
  })

  it('asks in full when another publisher sends the same id, however little it asks for', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    await apps.installAttachment({ messageId: await publish('vote', '9.0.0', MALLORY_UPLOADER) })
    expect(shell.asked.map((ask) => ask.installed)).toEqual([undefined])
  })

  it('摩擦单 F66 unasked: only a later version from the same publisher asking nothing new goes in — the rest is held, never asked', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    const unasked = async (messageId: string) => apps.installAttachment({ messageId, unasked: true })
    expect(await unasked(await publish('vote', '1.1.0', ALICE_UPLOADER, ['chat:relay']))).toMatchObject({ success: true, data: { installed: false, outcome: 'held' } })
    expect(await unasked(await publish('vote', '1.1.0', MALLORY_UPLOADER))).toMatchObject({ success: true, data: { installed: false, outcome: 'held' } })
    expect(await unasked(await publish('poll', '1.0.0'))).toMatchObject({ success: true, data: { installed: false, outcome: 'held' } })
    expect(shell.asked).toEqual([])
    expect(index().installed.vote!.dir).toBe('vote@1.0.0')
    expect(await unasked(await publish('vote', '1.1.0'))).toMatchObject({ success: true, data: { installed: true, version: '1.1.0', updatedFrom: '1.0.0' } })
    expect(index().installed.vote!.dir).toBe('vote@1.1.0')
    // Control: the card asking for more, clicked, is asked about.
    await apps.installAttachment({ messageId: await publish('vote', '1.2.0', ALICE_UPLOADER, ['chat:relay']) })
    expect(shell.asked).toHaveLength(1)
  })

  it('refuses a package under a preinstalled id (E-05), and refuses to uninstall a preinstalled App', async () => {
    const apps = await start()
    const replaced = await apps.installAttachment({ messageId: await publish('workspace', '2.0.0') })
    expect(replaced).toMatchObject({ success: true, data: { installed: false, outcome: 'refused', from: 'preinstalled', reason: expect.stringContaining('cannot replace it') } })
    expect(shell.versions.size).toBe(0)
    expect(await apps.uninstall('workspace')).toMatchObject({ success: false, error: expect.stringContaining('preinstalled') })
  })

  it('uninstalls: its files, its index entry, its origin storage and its data — the origin forgotten once', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    apps.pageUrl('vote', 'index.html')
    shell.token = jwt(BOB)
    apps.pageUrl('vote', 'index.html')

    expect(await apps.uninstall('vote')).toEqual({ success: true, data: null })
    expect(shell.versions.size).toBe(0)
    expect(index().installed.vote).toBeUndefined()
    expect(index().serve.vote).toBeUndefined()
    expect(shell.dataRemoved).toEqual(['vote'])
    // Its origin forgets its storage in place, on the platform's page — not the App's. Control (the parent commit): one
    // forget page per account that opened it, here two.
    expect(shell.forgotten).toEqual([`${appOrigin('vote')}${APP_RUNTIME_FORGET_PAGE}`])
    expect(lastList().extensions.map((app) => app.id)).toEqual(['workspace'])
  })

  it('switched off and on, as the desktop (161 10-16): the list the store reads, kept across a restart; the 群文件夹 and an App not here have no switch; uninstalling takes it off', async () => {
    let apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    expect(lastList().disabled).toEqual([])
    expect(await apps.setEnabled('vote', false)).toEqual({ success: true, data: null })
    expect(lastList().disabled).toEqual(['vote'])
    // Off keeps the App: its files and its index entry stay.
    expect(index().installed.vote).toBeDefined()
    expect(shell.versions.size).toBe(1)
    // Kept: the next start reads it as it was left.
    apps = await start()
    await apps.ready()
    expect(lastList().disabled).toEqual(['vote'])
    expect(await apps.setEnabled('vote', true)).toEqual({ success: true, data: null })
    expect(lastList().disabled).toEqual([])
    expect(await apps.setEnabled('workspace', false)).toMatchObject({ success: false, error: expect.stringContaining('preinstalled') })
    expect(await apps.setEnabled('nothing-here', false)).toMatchObject({ success: false, error: expect.stringContaining('not installed') })
    expect(lastList().disabled).toEqual([])
    // Uninstalled while off: "off" goes with it, and a reinstall arrives switched on.
    await apps.setEnabled('vote', false)
    await apps.uninstall('vote')
    expect(lastList().disabled).toEqual([])
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    expect(lastList().disabled).toEqual([])
  })

  it('an origin that never says it forgot does not hold the uninstall up', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    shell.forgetAnswers = false
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const uninstalling = apps.uninstall('vote')
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await uninstalling).toEqual({ success: true, data: null })
    } finally {
      vi.useRealTimers()
    }
    expect(index().installed.vote).toBeUndefined()
  })

  // 125 10-06, phone cell 2: a v2 App installed before the phone took a v3 build still opened and ran on the v3 runtime.
  // The phone reads each installed App with the desktop's one check. Control (the commit before): listed among the Apps, invalid empty.
  it('an installed App this build no longer reads is not offered: listed as invalid with its refusal as it is, still removable', async () => {
    shell.versions.set('old@1.0.0', new Map([['index.html', new Uint8Array(Buffer.from(`<!doctype html>${RUNTIME_SCRIPT_TAG}<p>v2</p>`))]]))
    const record = { dir: 'old@1.0.0', manifest: { ...manifest('old', '1.0.0'), apiVersion: 2 }, publisher: { id: ALICE_UPLOADER, name: 'Alice' }, sha256: '', manifestDigest: '', installedAt: '', runtimeTag: RUNTIME_SCRIPT_TAG, pages: ['index.html'], icons: {} }
    shell.index = JSON.stringify({ version: 1, installed: { old: record }, serve: {} })

    const apps = await start()
    await apps.ready()
    const list = lastList() as ReturnType<typeof lastList> & { invalid: { dirName: string; reason: string }[] }
    expect(list.extensions.map((app) => app.id)).toEqual(['workspace'])
    expect(list.invalid).toEqual([{ dirName: 'old', reason: expect.stringMatching(/^apiVersion: apiVersion 2 is an older App interface; ask an agent to rewrite/) }])

    expect(await apps.uninstall('old')).toEqual({ success: true, data: null })
    expect(index().installed.old).toBeUndefined()
    expect((lastList() as typeof list).invalid).toEqual([])
  })

  it('re-tags installed pages only when the build runtime line changed', async () => {
    const page = `<!doctype html>${OLD_TAG}<script src="app.js"></script>`
    shell.versions.set('vote@1.0.0', new Map([['index.html', new Uint8Array(Buffer.from(page))], ['app.js', new Uint8Array(Buffer.from('1'))]]))
    const record = { dir: 'vote@1.0.0', manifest: manifest('vote', '1.0.0'), publisher: { id: ALICE_UPLOADER, name: 'Alice' }, sha256: '', manifestDigest: '', installedAt: '', runtimeTag: OLD_TAG, pages: ['index.html'], icons: {} }
    shell.index = JSON.stringify({ version: 1, installed: { vote: record }, serve: {} })

    await (await start()).ready()
    expect(text('vote@1.0.0', 'index.html')).toBe(`<!doctype html>${RUNTIME_SCRIPT_TAG}<script src="app.js"></script>`)
    expect(index().installed.vote!.runtimeTag).toBe(RUNTIME_SCRIPT_TAG)

    // The same line: the page is not written again.
    shell.versions.get('vote@1.0.0')!.set('index.html', new Uint8Array(Buffer.from('untouched')))
    await (await start()).ready()
    expect(text('vote@1.0.0', 'index.html')).toBe('untouched')
  })
})

// owner 10-17: a file icon (`fileIcons`) is re-encoded where the tab icons are — a package's at install, a shipped App's at
// each start (its tab icon never drawn here) — and kept by `fileIconKey` beside them.
describe('the phone re-encodes file icons beside the tab icons (owner 10-17)', () => {
  it('a shipped App\'s file icons at start, an installed package\'s at install', async () => {
    const withIcons = (id: string, version: string) => ({ ...manifest(id, version), contributes: { tabs: [{ name: 'main', title: 'Main', icon: 'icon.png', opensFiles: { chat: ['.md', '.json'] }, fileIcons: { '.md': 'md.png' } }] } })
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { const url = `blob:${blobs.size}`; blobs.set(url, blob as Blob); return url })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    shell.shipped = [withIcons('workspace', '1.0.0')]
    shell.packages.set('/apps/workspace/md.png', new TextEncoder().encode('shipped-md'))
    shell.packages.set('/apps/workspace/icon.png', new TextEncoder().encode('shipped-tab'))
    const apps = await start()
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify(withIcons('vote', '1.0.0')))
    zip.file('index.html', '<!doctype html><title>v</title>')
    zip.file('icon.png', 'vote-tab')
    zip.file('md.png', 'vote-md')
    const url = `https://cdn.example.test/${ALICE_UPLOADER}/vote-1.0.0.guguext`
    shell.packages.set(url, await zip.generateAsync({ type: 'uint8array' }))
    const row = { id: 'm-icons', content: '[附件] vote-1.0.0.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file', file_item_id: 'item-m-icons', file_version: 1, file_blob_id: null, sender_user_id: ALICE_UPLOADER }
    cards.set('m-icons', { url, row })
    expect(await apps.installAttachment({ messageId: 'm-icons' })).toMatchObject({ success: true })
    expect((lastList() as unknown as { icons: Record<string, string> }).icons).toEqual({
      [fileIconKey('workspace.main', '.md')]: 'png:shipped-md',
      'vote.main': 'png:vote-tab',
      [fileIconKey('vote.main', '.md')]: 'png:vote-md',
    })
  })
})

// owner 10-17: a tab that names no icon of its own is drawn with its App's (日历、雷达), as on the desktop.
describe('the phone draws a tab without an icon of its own with its App\'s (owner 10-17)', () => {
  it('the App\'s icon is re-encoded as that tab\'s at install', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { const url = `blob:${blobs.size}`; blobs.set(url, blob as Blob); return url })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const apps = await start()
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify({ ...manifest('vote', '1.0.0'), icon: 'app.png' }))
    zip.file('index.html', '<!doctype html><title>v</title>')
    zip.file('app.png', 'vote-app')
    const url = `https://cdn.example.test/${ALICE_UPLOADER}/vote-1.0.0.guguext`
    shell.packages.set(url, await zip.generateAsync({ type: 'uint8array' }))
    const row = { id: 'm-app-icon', content: '[附件] vote-1.0.0.guguext (application/vnd.gugu.extension+zip)\n[Size] 9\n[Kind] file', file_item_id: 'item-m-app-icon', file_version: 1, file_blob_id: null, sender_user_id: ALICE_UPLOADER }
    cards.set('m-app-icon', { url, row })
    expect(await apps.installAttachment({ messageId: 'm-app-icon' })).toMatchObject({ success: true })
    expect((lastList() as unknown as { icons: Record<string, string> }).icons).toEqual({ 'vote.main': 'png:vote-app' })
  })
})

describe('pageUrl: where an App page is on the phone (L3 review)', () => {
  it("is the App's own origin, the same whoever is signed in — never the shell page's", async () => {
    const apps = await start()
    for (const token of [jwt(ALICE), jwt(BOB), null]) {
      shell.token = token
      for (const id of ['vote', 'workspace', 'localhost']) {
        const url = new URL(apps.pageUrl(id, '/more/page.html'))
        expect(url.origin).toBe(appOrigin(id))
        expect(url.origin).not.toBe(SHELL)
        expect(url.pathname).toBe('/more/page.html')
      }
    }
  })

  it('control: the phone page URL before L9 (/apps/<id>/<entry> on the shell) was the shell origin itself', () => {
    expect(new URL('/apps/vote/index.html', SHELL).origin).toBe(SHELL)
  })
})

describe("gugu.data on the phone: the App's, gone with the App (L3 review)", () => {
  it('another account signed in on the phone reads what the App kept (主人 10-01)', async () => {
    const apps = await start()
    await apps.data.write('vote', 'notes/today.json', '{"a":1}')
    shell.token = jwt(BOB)
    // Control (the parent commit): null and [] — each account had a folder of its own.
    expect(await apps.data.read('vote', 'notes/today.json')).toBe('{"a":1}')
    expect(await apps.data.list('vote', '.')).toEqual([{ path: 'notes/today.json', kind: 'file' }])
  })

  it('refuses what the desktop refuses: more than the App data limit, in the desktop words', async () => {
    const apps = await start()
    await expect(apps.data.write('vote', 'big', 'x'.repeat(8 * 1024 * 1024 + 1))).rejects.toThrow('file is larger than 8388608 bytes')
  })

  it('uninstalling removes its data; a reinstall starts empty', async () => {
    const apps = await start()
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    await apps.data.write('vote', 'kept', 'alice')
    expect(await apps.data.read('vote', 'kept')).toBe('alice')
    await apps.uninstall('vote')
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    expect(await apps.data.read('vote', 'kept')).toBeNull()
  })
})

// 161 10-15: the phone installs market Apps — the market's index and packages read through the shell (the download site sends
// no CORS headers), each package checked against the sha256 its row recorded, asked about like any install, stored as the
// market's App (gugu's). The three ways to ask are main's (installExtensionFromMarket): here, `return`, `given`.
describe('the phone installs Apps from the market', () => {
  const source = { repo: 'shuxueshuxue/gugu-apps', path: 'sources/notes', commit: 'c'.repeat(40) }

  /** Publishes one version of an App in the market as its index lists it; `tamper` serves other bytes than the row records. */
  async function list(id: string, version: string, capabilities: string[] = [], tamper = false, bigger = false, at = source) {
    const zip = new JSZip()
    zip.file('manifest.json', JSON.stringify(manifest(id, version, capabilities)))
    zip.file('index.html', `<!doctype html><title>${version}</title>`)
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    const bundle = `bundles/${id}/${version}.zip`
    // Tampered: one byte in the middle flipped, the same size (a zip's last bytes are often 0 already — changing those may change nothing).
    const served = bytes.slice()
    const middle = Math.floor(served.length / 2)
    if (tamper) served[middle] = (served[middle] ?? 0) ^ 0xff
    // Bigger: what the site serves is longer than the row recorded (the file swapped or grown under the same version).
    shell.market.set(bundle, bigger ? new Uint8Array([...served, ...new Uint8Array(4096)]) : served)
    const row = {
      version, manifest: manifest(id, version, capabilities), apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0',
      releaseNotes: `what ${version} changed`, publishedAt: '2026-10-15T00:00:00Z', sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength, bundle, icon: null, readme: null, source: at, yanked: null,
    }
    shell.market.set('index.json', new TextEncoder().encode(JSON.stringify({ apps: [{ id, deprecated: null, versions: [row] }] })))
  }
  const bundleReads = () => shell.marketReads.filter((path) => path.startsWith('bundles/'))

  it('asks here, saying where its code is and what this version changed; stores it as the market’s, gugu’s', async () => {
    await list('notes', '1.0.0', ['files:read'])
    const apps = await start()
    const result = await apps.installFromMarket({ ref: { extensionId: 'notes' } })

    expect(result).toMatchObject({ success: true, data: { installed: true, outcome: 'confirmed', id: 'notes', version: '1.0.0' } })
    expect(shell.asked).toHaveLength(1)
    expect(shell.asked[0]).toMatchObject({ market: { source, releaseNotes: 'what 1.0.0 changed' } })
    expect([...shell.versions.keys()]).toEqual(['notes@1.0.0'])
    expect(JSON.parse(shell.index!).installed.notes).toMatchObject({ origin: 'market' })
    expect(lastList().publishers.notes).toEqual({ id: 'gugu' })
  })

  it('`return` hands back what it would ask and keeps the package; `given` installs it — read from the market once', async () => {
    await list('notes', '1.0.0', ['files:read'])
    const apps = await start()
    const asked = await apps.installFromMarket({ ref: { extensionId: 'notes' }, consent: { kind: 'return' } })
    expect(asked).toMatchObject({ success: true, data: { installed: false, outcome: 'ask', asks: true } })
    expect(shell.versions.size).toBe(0)
    const digest = asked.success && asked.data.outcome === 'ask' ? asked.data.ask.manifestDigest : ''

    const done = await apps.installFromMarket({ ref: { extensionId: 'notes', version: '1.0.0' }, consent: { kind: 'given', digest } })
    expect(done).toMatchObject({ success: true, data: { installed: true } })
    // Asked by the caller, never here; and the package came down once.
    expect(shell.asked).toEqual([])
    expect(bundleReads()).toEqual(['bundles/notes/1.0.0.zip'])
  })

  it('`return` for an App asking nothing this phone can grant says so (asks: false)', async () => {
    await list('notes', '1.0.0', ['agents:history'])
    const apps = await start()
    await expect(apps.installFromMarket({ ref: { extensionId: 'notes' }, consent: { kind: 'return' } }))
      .resolves.toMatchObject({ success: true, data: { outcome: 'ask', asks: false } })
  })

  it('bytes other than the ones the market recorded are refused before anything is read from them', async () => {
    await list('notes', '1.0.0', [], true)
    const apps = await start()
    const result = await apps.installFromMarket({ ref: { extensionId: 'notes' } })
    expect(result).toMatchObject({ success: false })
    expect(!result.success && result.error).toMatch(/does not match what was published/)
    expect(shell.versions.size).toBe(0)
  })

  // Review 10-15 (复核·二代): the package is held whole in the page and in the shell (base64) — a bigger one than its row says
  // stops in the shell while it comes, never filling the phone's memory first.
  it('a package is read with its row’s size as the cap: a bigger one is stopped while it comes, nothing stored', async () => {
    await list('notes', '1.0.0', [], false, true)
    const apps = await start()
    const result = await apps.installFromMarket({ ref: { extensionId: 'notes' } })
    expect(!result.success && result.error).toMatch(/is larger than \d+ bytes/)
    const row = JSON.parse(new TextDecoder().decode(shell.market.get('index.json'))).apps[0].versions[0]
    expect(shell.marketCaps[shell.marketReads.indexOf('bundles/notes/1.0.0.zip')]).toBe(row.bytes)
    expect(shell.versions.size).toBe(0)
  })

  it('what the market offers now for the Apps installed from it — a chat’s App is not asked about', async () => {
    await list('notes', '1.0.0')
    const apps = await start()
    await apps.installFromMarket({ ref: { extensionId: 'notes' } })
    await apps.installAttachment({ messageId: await publish('vote', '1.0.0') })
    // 1.1.0 asks for more: it waits for the person's 「更新」 (owner 10-19 auto-update leaves it), so it is still offered below.
    await list('notes', '1.1.0', ['files:read'])
    // From the index in hand at once (the one the install took); the page asks the download site behind it (market-snapshot.ts).
    expect(await apps.marketUpdates()).toMatchObject({ success: true, data: { updates: {} } })
    expect(await apps.market.refresh()).toMatchObject({ outcome: 'changed' })
    const result = await apps.marketUpdates()
    expect(result).toMatchObject({ success: true, data: { updates: { notes: { version: '1.1.0', releaseNotes: 'what 1.1.0 changed' } } } })
    expect(result.success && Object.keys(result.data.updates)).toEqual(['notes'])
    expect(apps.originOf('notes')).toBe('market')
    expect(apps.originOf('vote')).toBe('attachment')
  })

  it('the index in hand is kept between runs (the page storage): the next start says 「更新到 vX」 without the download site', async () => {
    await list('notes', '1.0.0')
    const first = await start()
    await first.installFromMarket({ ref: { extensionId: 'notes' } })
    await list('notes', '1.1.0')
    await first.market.refresh()
    // The download site out of reach on the next start: what it says comes from the index kept.
    shell.market.clear()
    const apps = await start()
    expect(await apps.marketUpdates()).toMatchObject({ success: true, data: { updates: { notes: { version: '1.1.0' } } } })
  })

  /** Every version listed in one index (`list` lists one); each packed by `list`. */
  async function listAll(id: string, versions: { version: string; capabilities?: string[] }[]) {
    const rows: unknown[] = []
    for (const one of versions) {
      await list(id, one.version, one.capabilities ?? [])
      rows.push(JSON.parse(new TextDecoder().decode(shell.market.get('index.json'))).apps[0].versions[0])
    }
    shell.market.set('index.json', new TextEncoder().encode(JSON.stringify({ apps: [{ id, deprecated: null, versions: rows }] })))
  }
  const installedDir = (id: string) => (JSON.parse(shell.index ?? '{}').installed?.[id]?.dir as string | undefined)
  /** The background pass given its turns — a bounded number, never a clock. */
  async function settle(fact: () => boolean) {
    for (let turn = 0; turn < 200 && !fact(); turn++) await new Promise((resolve) => setTimeout(resolve, 0))
    return fact()
  }

  // owner 10-19: market Apps update by themselves on the phone too (phoneApps `autoUpdate`), as on the desktop.
  it('keeps an installed API 10 App without platforms readable and updates it; one asking for more waits', async () => {
    await listAll('notes', [{ version: '1.0.0' }])
    let apps = await start()
    await apps.installFromMarket({ ref: { extensionId: 'notes' } })
    // A phone profile kept by the old client: runtime must not apply the new installation rule to it.
    const kept = JSON.parse(shell.index!)
    const record = kept.installed.notes
    record.manifest.apiVersion = 10
    delete record.manifest.platforms
    const oldManifest = JSON.stringify(record.manifest)
    record.manifestDigest = createHash('sha256').update(oldManifest).digest('hex')
    shell.versions.get(record.dir)!.set('manifest.json', new TextEncoder().encode(oldManifest))
    shell.index = JSON.stringify(kept)
    apps = await start()
    await apps.ready()
    expect(lastList().extensions.find((entry) => entry.id === 'notes')).toMatchObject({ apiVersion: 10, version: '1.0.0' })
    expect(apps.installedFromChats().find((entry) => entry.id === 'notes')?.platforms).toBeUndefined()

    await listAll('notes', [{ version: '1.0.0' }, { version: '1.1.0' }])
    expect(await apps.market.refresh()).toMatchObject({ outcome: 'changed' })
    expect(await settle(() => installedDir('notes') === 'notes@1.1.0')).toBe(true)
    expect(shell.asked).toEqual([])

    await listAll('notes', [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.2.0', capabilities: ['files:read'] }])
    await apps.market.refresh()
    await settle(() => false)
    expect(installedDir('notes')).toBe('notes@1.1.0')
    expect(bundleReads()).not.toContain('bundles/notes/1.2.0.zip')
  })

  it('an older version installed stays: 「自动更新」 off, not updated; switched back on, updated at once', async () => {
    await listAll('notes', [{ version: '1.0.0' }, { version: '1.1.0' }])
    const apps = await start()
    await apps.installFromMarket({ ref: { extensionId: 'notes', version: '1.0.0' } })
    expect(JSON.parse(shell.index!).autoUpdateOff).toEqual(['notes'])
    expect(lastList().autoUpdateOff).toEqual(['notes'])
    await listAll('notes', [{ version: '1.0.0' }, { version: '1.1.0' }, { version: '1.1.1' }])
    await apps.market.refresh()
    await settle(() => false)
    expect(installedDir('notes')).toBe('notes@1.0.0')

    expect(await apps.setAutoUpdate('notes', true)).toMatchObject({ success: true })
    expect(await settle(() => installedDir('notes') === 'notes@1.1.1')).toBe(true)
    expect(JSON.parse(shell.index!).autoUpdateOff).toEqual([])
  })

  // 161 10-16: the first-run set goes in asking nobody — gugu's own only (its code in gugu's repository), never over one here.
  it("`gugu`: gugu's own App goes in asking nobody, as the market's; never over one installed here", async () => {
    await list('notes', '1.0.0', ['files:read'])
    const apps = await start()
    await expect(apps.installFromMarket({ ref: { extensionId: 'notes', version: '1.0.0' }, consent: { kind: 'gugu' } }))
      .resolves.toMatchObject({ success: true, data: { installed: true, outcome: 'confirmed', id: 'notes' } })
    expect(shell.asked).toEqual([])
    expect(JSON.parse(shell.index!).installed.notes).toMatchObject({ origin: 'market', manifest: { permissions: { capabilities: ['files:read'] } } })
    const again = await apps.installFromMarket({ ref: { extensionId: 'notes', version: '1.0.0' }, consent: { kind: 'gugu' } })
    expect(!again.success && again.error).toMatch(/installed here already/)
  })

  it("`gugu`: an App whose code is in someone else's repository is refused, nothing stored", async () => {
    await list('notes', '1.0.0', ['files:read'], false, false, { repo: 'someone/their-apps', path: '.', commit: 'd'.repeat(40) })
    const apps = await start()
    const result = await apps.installFromMarket({ ref: { extensionId: 'notes', version: '1.0.0' }, consent: { kind: 'gugu' } })
    expect(!result.success && result.error).toMatch(/not gugu's own App \(its code is at someone\/their-apps\)/)
    expect(shell.versions.size).toBe(0)
    expect(shell.asked).toEqual([])
  })

  it('an App gugu ships cannot be replaced from the market (E-05)', async () => {
    await list('workspace', '9.0.0')
    const apps = await start()
    const result = await apps.installFromMarket({ ref: { extensionId: 'workspace' } })
    expect(!result.success && result.error).toMatch(/ships with gugu/)
    expect(shell.versions.size).toBe(0)
  })
})

// 161 10-15: the first-run set's record lives in the App store index. The phone's first start is the one with no index at
// all; an index from before this (an App store that has run) is not a new profile — nothing is put in.
describe('the first-run record on the phone', () => {
  it('no index yet: this is the first start — pending, kept in the index', async () => {
    const apps = await start()
    await expect(apps.firstRun.get()).resolves.toEqual({ success: true, data: { state: 'pending' } })
    expect(JSON.parse(shell.index!).firstRun).toEqual({ state: 'pending' })
  })

  it('an index written before the first-run record: an existing profile, nothing put in', async () => {
    shell.index = JSON.stringify({ version: 1, installed: {}, serve: {} })
    const apps = await start()
    await expect(apps.firstRun.get()).resolves.toEqual({ success: true, data: { state: 'existing' } })
  })

  it('the record is kept across starts — and a record of another shape is refused, not kept', async () => {
    const apps = await start()
    await apps.firstRun.set({ state: 'pending', apps: ['office'], installed: [] })
    const again = await start()
    await expect(again.firstRun.get()).resolves.toEqual({ success: true, data: { state: 'pending', apps: ['office'], installed: [] } })
    await expect(again.firstRun.set({ state: 'maybe' } as never)).resolves.toMatchObject({ success: false })
    await expect(again.firstRun.get()).resolves.toMatchObject({ data: { state: 'pending' } })
  })
})
