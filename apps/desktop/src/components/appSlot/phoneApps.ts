import { registerPlugin } from '@capacitor/core'
import { readDisplayIdentities } from '../../lib/identityReadAdapter'
import { rendererLogger } from '../../lib/log'
import { redrawImage } from '../../lib/redrawImage'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { askInShell, installConsentPrompt, type InstallConsentAsk } from '../../session/renderer/features/extensions/install-consent'
import { extensionContentSecurityPolicy } from '../../session/shared/extensions/app-csp'
import { appDataTooLarge } from '../../session/shared/extensions/app-data'
import { GUGU_PUBLISHER, publisherOf, type Publisher } from '../../session/shared/extensions/app-identity'
import { appFrameChannel, appOrigin } from './appOrigin'
import { ICON_PIXELS, fileIconKey, iconSizeRefusal, iconTypeRefusal } from '../../session/shared/extensions/app-icon'
import { APP_RUNTIME_FORGET_PAGE, injectAppRuntime, RUNTIME_SCRIPT_TAG } from '../../session/shared/extensions/app-runtime-protocol'
import {
  attachmentInstallPlan,
  couldUpdateUnasked,
  grantableBy,
  PACKAGE_MESSAGE_SELECT,
  resolveAttachmentPackage,
  packageBytes,
  type AttachmentInstallRefused,
  type AttachmentPackage,
  type InstalledApp,
  type PackageMessageRow,
  type PackageReads,
} from '../../session/shared/extensions/attachment-install'
import { archiveRefusal, bundleProblems, unpackedTooMuch, type BundleEntry } from '../../session/shared/extensions/bundle-checks'
import { INSTALL_CONSENT_HUMAN_WINDOW_MS } from '../../session/shared/extensions/host-actions'
import { agreeThenInstall, type InstallConsent } from '../../session/shared/extensions/install-consent-flow'
import { extensionTabKind, safeParseExtensionManifest, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import { PHONE_CAPABILITIES, requireAppPlatform } from '../../session/shared/extensions/app-platforms'
import { BUNDLE_SKIP_NAMES, currentMarketHost, type MarketCodeSource, type MarketUpdatesSummary } from '../../session/shared/extensions/market'
import { autoUpdatesFrom, pinsAutoUpdate } from '../../session/shared/extensions/market-entries'
import { installAsks } from '../../session/shared/extensions/upgrade'
import { firstRunRecordSchema, isGuguOwnApp, type FirstRunRecord } from '../../session/shared/extensions/first-run'
import { phoneMarket } from './phoneMarket'
import feeds from '../../../electron/updateFeeds.json'

declare const __APP_VERSION__: string

const log = rendererLogger('app-slot/phone-apps')

export { PHONE_CAPABILITIES } from '../../session/shared/extensions/app-platforms'

/**
 * The phone's App store (L9, 摩擦单 F76): the Apps on this phone — the ones gugu ships in its bundle, and the ones the
 * person installed from a card in a chat — and the one way to install and uninstall them.
 *
 * What may be installed and what the person is asked is the desktop's own answer (`attachmentInstallPlan`), the package
 * passes the desktop's checks (`archiveRefusal` / `unpackedTooMuch` / `bundleProblems`), consent is the same sheet with
 * the same words (`installConsentPrompt`), each page gets the same runtime line (`injectAppRuntime`) and the same CSP
 * (`extensionContentSecurityPolicy`), and the icons are re-encoded under the same rules (app-icon.ts). What only the
 * phone does is keep the files: the shell's App store (GuguAppStorePlugin) holds each version under <id>@<version>, and
 * serves every App from an origin of its own (AppOrigins.java).
 *
 * What is installed is told to `installedExtensionsStore`, the store the desktop fills from main: the card, the group's
 * panel and 「用 X 打开」 read one store on both.
 */

interface AppStorePlugin {
  stage(args: { stage: string; path: string; base64: string }): Promise<void>
  commit(args: { stage: string; dir: string }): Promise<void>
  discard(args: { stage: string } | { dir: string }): Promise<void>
  list(): Promise<{ dirs: string[]; stages: number }>
  readText(args: { dir: string; path: string }): Promise<{ text: string }>
  writeText(args: { dir: string; path: string; text: string }): Promise<void>
  readIndex(): Promise<{ json: string | null }>
  /**
   * A file of the App market, read by the shell (DownloadSite): the page cannot read the download site itself. `maxBytes`:
   * what the file is known to be (a package's row), so a bigger one stops while it comes.
   */
  marketRead(args: { path: string; maxBytes?: number }): Promise<{ base64: string }>
  writeIndex(args: { json: string }): Promise<void>
  dataRead(args: { app: string; path: string }): Promise<{ text: string | null }>
  dataWrite(args: { app: string; path: string; text: string }): Promise<void>
  dataList(args: { app: string; path: string }): Promise<{ entries: { path: string; kind: 'file' | 'directory' }[] }>
  dataRemove(args: { app: string }): Promise<void>
}
const appStore = registerPlugin<AppStorePlugin>('GuguAppStore')

/** An App installed from a chat or the market, as the index keeps it. */
interface InstalledRecord {
  dir: string
  manifest: ExtensionManifest
  /** Where it came from; none: from a chat (kept before the phone installed market Apps). */
  origin?: 'attachment' | 'market'
  /** Who published it, as the server vouched when it was installed (摩擦单 F66). */
  publisher: Publisher
  sha256: string
  manifestDigest: string
  installedAt: string
  /** The runtime line its pages were given: written again only when the build's line changes. */
  runtimeTag: string
  /** Its pages (every .html), which carry that line. */
  pages: string[]
  /** Tab kind → the icon, and `fileIconKey` → a file icon (`fileIcons`): re-encoded by this page. */
  icons: Record<string, string>
}

/** What the shell serves an App from, and with which policy (read by AppOrigins.java). */
interface Served {
  root: string
  csp: string
}

interface Index {
  version: 1
  installed: Record<string, InstalledRecord>
  serve: Record<string, Served>
  /**
   * The first-run set's record (161 10-15). An index written before it had none: that phone had run gugu's App store
   * already — not a new profile (`existing`). No index at all: this is the first start (`pending`).
   */
  firstRun?: FirstRunRecord
  /**
   * The Apps the person switched off (161 10-16: every App has its switch, as on the desktop): the desktop's
   * `.disabled-extensions.json`, the same list read the same way (`installedExtensionsStore.isEnabled`) — not opened, not
   * offered for a file, not in a menu; its files, data and what it was allowed stay. Uninstalling takes it off the list:
   * a reinstall arrives switched on.
   */
  disabled?: string[]
  /**
   * The market Apps not updated by themselves (owner 10-19, as on the desktop: `.auto-update-off.json`): the person switched
   * 「自动更新」 off, or installed an older version than the market gives this phone. Uninstalling takes it off the list.
   */
  autoUpdateOff?: string[]
}

/** The Apps gugu ships in this bundle (phoneAppsPlugin in vite.config.mts). */
async function readShipped(): Promise<ExtensionManifest[]> {
  const response = await fetch('/apps/index.json')
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const raw = (await response.json()) as unknown[]
  return raw.flatMap((entry) => {
    const parsed = safeParseExtensionManifest(entry)
    return parsed.ok ? [parsed.manifest] : []
  })
}

let shipped: ExtensionManifest[] = []
let shippedIcons: Record<string, string> = {}
let index: Index = { version: 1, installed: {}, serve: {} }

/** 「始终用它」 on the phone: kept in this page (the desktop keeps it in main). */
const OPEN_WITH_KEY = 'gugu.openWithDefaults'
function rememberedAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OPEN_WITH_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Every page is the gugu page's to frame (frame-ancestors): the phone draws each App in an iframe of it. */
const cspOf = (manifest: ExtensionManifest) => extensionContentSecurityPolicy(location.origin, manifest.permissions?.network ?? [])

function tell(): void {
  const installed = Object.values(index.installed)
  // Each installed App read with the desktop's one check, as the desktop reads its folders: one this build no longer runs
  // (installed under an older apiVersion, say) is not opened — listed as invalid with its refusal as it is, still removable.
  const checked = installed.map((record) => ({ record, parsed: safeParseExtensionManifest(record.manifest) }))
  installedExtensionsStore.applyList({
    extensions: [...shipped, ...checked.flatMap(({ parsed }) => (parsed.ok ? [parsed.manifest] : []))],
    invalid: checked.flatMap(({ record, parsed }) => (parsed.ok ? [] : [{ dirName: record.manifest.id, reason: parsed.issues.join('; ') }])),
    icons: Object.assign({ ...shippedIcons }, ...installed.map((record) => record.icons)) as Record<string, string>,
    // The far-left rail and its dock are the desktop's: the phone has neither.
    appIcons: {},
    dock: [],
    disabled: index.disabled ?? [],
    autoUpdateOff: index.autoUpdateOff ?? [],
    // Quit from the rail (#7050): the phone has no rail, and no background to stop.
    quit: [],
    // Tabs taken out of task sessions (摩擦单 F95): the phone has no task sessions.
    disclosure: {},
    // Where each came from, as `installedHere` reads it (E-05): a record without one came from a chat.
    origins: Object.fromEntries([
      ...shipped.map((manifest) => [manifest.id, 'preinstalled' as const]),
      ...installed.map((record) => [record.manifest.id, record.origin ?? ('attachment' as const)]),
    ]),
    openWith: rememberedAll(),
    publishers: Object.fromEntries(installed.map((record) => [record.manifest.id, record.publisher])),
  })
}

let loading: Promise<void> | null = null
/** Read once per page load: what is installed, the shipped Apps' serving, pages re-tagged if the runtime line changed. */
function ready(): Promise<void> {
  loading ??= load().catch((error: unknown) => {
    loading = null
    throw error
  })
  return loading
}

/**
 * Why the index could not be read this page load (null: it was). Then nothing is written over it and no App's files go:
 * what can be read is drawn, every change is refused (`writable`) and the settings page offers to read it again (`reload`).
 */
let unreadable: string | null = null
const UNREADABLE = 'The list of Apps on this phone could not be read, so nothing was changed. Try again.'

/** The switched-off list as last written, kept apart from the index: what stays off while the index cannot be read. */
const DISABLED_KEY = 'gugu.phoneApps.disabled'
function lastDisabled(): string[] | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISABLED_KEY) ?? 'null')
    return Array.isArray(parsed) && parsed.every((id) => typeof id === 'string') ? parsed : null
  } catch {
    return null
  }
}

const isIdList = (value: unknown): value is string[] | undefined => value === undefined || (Array.isArray(value) && value.every((id) => typeof id === 'string'))

/** The index read as it is stored; a part that is not what it should be makes the whole unreadable (thrown). */
function parseIndex(stored: string): Index {
  const parsed = JSON.parse(stored) as Partial<Index> | null
  if (!parsed || typeof parsed !== 'object' || !isIdList(parsed.disabled) || !isIdList(parsed.autoUpdateOff)) throw new Error('the App store index is not an index')
  const firstRun = firstRunRecordSchema.safeParse(parsed.firstRun)
  return { version: 1, installed: parsed.installed ?? {}, serve: parsed.serve ?? {}, firstRun: firstRun.success ? firstRun.data : { state: 'existing' }, disabled: parsed.disabled ?? [], autoUpdateOff: parsed.autoUpdateOff ?? [] }
}

/** The Apps an index that cannot be read whole still names, to draw them (none when it is not JSON at all). */
function installedIn(stored: string | null): Record<string, InstalledRecord> {
  try {
    const installed = (JSON.parse(stored ?? 'null') as Partial<Index> | null)?.installed
    return installed && typeof installed === 'object' ? installed : {}
  } catch {
    return {}
  }
}

/** Every write of the index; refused while it could not be read, so what is stored is never written over. */
async function save(): Promise<void> {
  if (unreadable) throw new Error(UNREADABLE)
  await appStore.writeIndex({ json: JSON.stringify(index) })
  localStorage.setItem(DISABLED_KEY, JSON.stringify(index.disabled ?? []))
}

/** What every change waits for: the index read, and read whole. */
async function writable(): Promise<void> {
  await ready()
  if (unreadable) throw new Error(UNREADABLE)
}

let listening = false

async function load(): Promise<void> {
  shipped = await readShipped()
  shippedIcons = Object.assign({}, ...(await Promise.all(shipped.map((manifest) => iconsOf(manifest, (path) => shippedFile(manifest.id, path), true)))))
  index = { version: 1, installed: {}, serve: {} }
  unreadable = null
  let stored: string | null = null
  try {
    stored = (await appStore.readIndex()).json
    // No index: this phone's first start — the first-run set goes in (161 10-15; silently, owner 10-16).
    if (stored) index = parseIndex(stored)
    else index.firstRun = { state: 'pending' }
  } catch (error) {
    unreadable = error instanceof Error ? error.message : String(error)
    log.error({ error: unreadable }, 'the App store index could not be read; it is left as it is and nothing is changed')
    index.installed = installedIn(stored)
    // What was switched off stays off; never written down here, every App installed is off (fail closed).
    index.disabled = lastDisabled() ?? Object.keys(index.installed)
    index.firstRun = { state: 'existing' }
  }
  // A shipped App's id is gugu's: a package installed under it before (not possible now, E-05) never shadows it.
  for (const manifest of shipped) {
    delete index.installed[manifest.id]
    index.serve[manifest.id] = { root: `asset:public/apps/${manifest.id}`, csp: cspOf(manifest) }
  }
  for (const record of Object.values(index.installed)) {
    index.serve[record.manifest.id] = { root: `file:${record.dir}`, csp: cspOf(record.manifest) }
    if (!unreadable && record.runtimeTag !== RUNTIME_SCRIPT_TAG) await retag(record)
  }
  if (unreadable) {
    tell()
    return
  }
  await save()
  // What no index entry names — an older version, an install that stopped half way — goes now, before any page opens.
  const named = new Set(Object.values(index.installed).map((record) => record.dir))
  const { dirs } = await appStore.list()
  for (const dir of dirs) if (!named.has(dir)) await appStore.discard({ dir })
  tell()
  // Market Apps update by themselves (owner 10-19): once a page load, after the index is asked for; then whenever it changes.
  if (!listening) {
    listening = true
    market.onRefreshed((refreshed) => {
      if (refreshed.outcome === 'changed' && !unreadable) void autoUpdate()
    })
  }
  void market.refresh().then(() => autoUpdate())
}

/** The settings page's 「重试」: the index read again from the start. */
function reload(): Promise<void> {
  loading = null
  return ready()
}

/** The build's runtime line changed (its format or `/_gugu/<ver>/`): the installed pages are given the new one. */
async function retag(record: InstalledRecord): Promise<void> {
  for (const page of record.pages) {
    const { text } = await appStore.readText({ dir: record.dir, path: page })
    await appStore.writeText({ dir: record.dir, path: page, text: injectAppRuntime(text.split(record.runtimeTag).join('')) })
  }
  record.runtimeTag = RUNTIME_SCRIPT_TAG
}

// ─── install ───────────────────────────────────────────────────────────────

const HTML = /\.html?$/i

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
}
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

interface JSZipChunks {
  on(event: 'data', listener: (chunk: Uint8Array) => void): JSZipChunks
  on(event: 'error', listener: (error: Error) => void): JSZipChunks
  on(event: 'end', listener: () => void): JSZipChunks
  resume(): JSZipChunks
  pause(): JSZipChunks
}

/**
 * A package's files, unpacked in this page with the desktop's checks: the entry count and every path before anything
 * is inflated, the bytes counted as they come, then what it holds. Names the packer skips are not kept.
 */
async function unpack(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytes)
  const all = Object.values(zip.files)
  const refusal = archiveRefusal(all.map((entry) => entry.name))
  if (refusal) throw new Error(refusal)
  const files = new Map<string, Uint8Array>()
  const entries: BundleEntry[] = []
  let total = 0
  for (const entry of all) {
    const path = entry.name.replace(/\/$/, '')
    if (path.split('/').some((segment) => BUNDLE_SKIP_NAMES.has(segment))) continue
    if (entry.dir) {
      entries.push({ path, kind: 'directory', bytes: 0 })
      continue
    }
    const chunks: Uint8Array[] = []
    await new Promise<void>((resolve, reject) => {
      // JSZip's own stream (in its runtime, absent from its typings): the bytes come a chunk at a time, so the count
      // stops a bomb before it is in memory — as main counts `nodeStream` chunks.
      const stream = (entry as unknown as { internalStream(type: 'uint8array'): JSZipChunks }).internalStream('uint8array')
      stream
        .on('data', (chunk: Uint8Array) => {
          total += chunk.byteLength
          const tooMuch = unpackedTooMuch(total)
          if (tooMuch) {
            stream.pause()
            reject(new Error(tooMuch))
            return
          }
          chunks.push(chunk)
        })
        .on('error', reject)
        .on('end', () => resolve())
        .resume()
    })
    const data = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let at = 0
    for (const chunk of chunks) {
      data.set(chunk, at)
      at += chunk.byteLength
    }
    files.set(path, data)
    entries.push({ path, kind: 'file', bytes: data.byteLength })
  }
  const problems = bundleProblems(entries)
  if (problems.length > 0) throw new Error(`this App package has problems:\n- ${problems.join('\n- ')}`)
  return files
}

/**
 * An App's file icons (`fileIcons`, by `fileIconKey`) and, unless `fileIconsOnly`, its tab icons, re-encoded by this page:
 * an installed package's at install, a shipped App's file icons at each page load (its tabs have never drawn one here).
 */
async function iconsOf(
  manifest: ExtensionManifest,
  read: (path: string) => Promise<Uint8Array | undefined>,
  fileIconsOnly = false,
): Promise<Record<string, string>> {
  const icons: Record<string, string> = {}
  for (const tab of manifest.contributes.tabs) {
    const tabKind = extensionTabKind(manifest.id, tab.name)
    const wanted: [string, string][] = Object.entries(tab.fileIcons ?? {}).map(([claim, path]) => [fileIconKey(tabKind, claim), path])
    // A tab without an icon of its own is drawn with its App's, as on the desktop (controller.ts).
    const tabIcon = tab.icon ?? manifest.icon
    if (tabIcon && !fileIconsOnly) wanted.push([tabKind, tabIcon])
    for (const [key, path] of wanted) {
      const icon = await iconOf(path, await read(path))
      if (icon) icons[key] = icon
    }
  }
  return icons
}

/** A shipped App's file, as the build put it next to its manifest (phoneAppsPlugin). */
async function shippedFile(id: string, path: string): Promise<Uint8Array | undefined> {
  const response = await fetch(`/apps/${id}/${path}`)
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined
}

/** A tab's icon as this page re-encodes it (app-icon.ts: the desktop's types, limit and size), or none. */
async function iconOf(path: string, bytes: Uint8Array | undefined): Promise<string | null> {
  if (!bytes || iconTypeRefusal(path) || iconSizeRefusal(bytes.byteLength)) return null
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]))
  try {
    return await redrawImage(url, { size: ICON_PIXELS, fit: 'fill', type: 'image/png' })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function installedHere(id: string): InstalledApp | undefined {
  const shippedApp = shipped.find((manifest) => manifest.id === id)
  if (shippedApp) return { manifest: shippedApp, origin: 'preinstalled', publisher: null, revokedPermissions: [] }
  const record = index.installed[id]
  return record ? { manifest: record.manifest, origin: record.origin ?? 'attachment', publisher: record.publisher, revokedPermissions: [] } : undefined
}

export type PhoneInstallOutcome = {
  installed: boolean
  outcome: 'confirmed' | 'declined' | 'dismissed' | 'timeout' | 'held'
  id: string
  name: string
  version: string
  sha256: string
  updatedFrom?: string
} | { installed: false; outcome: 'ask'; id: string; name: string; version: string; sha256: string; ask: InstallConsentAsk; asks: boolean }

type Result<T> = { success: true; data: T } | { success: false; error: string }

/** A package read and checked in this page: its files, its manifest as written (stored whole), and their digests. */
interface ReadPackage {
  files: Map<string, Uint8Array>
  manifest: ExtensionManifest
  manifestDigest: string
  sha256: string
}

/** The package's files with the desktop's checks (`unpack`), its manifest valid for this build, its entry page there. */
async function readPackage(bytes: Uint8Array): Promise<ReadPackage> {
  const digest = await sha256(bytes)
  const files = await unpack(bytes)
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes) throw new Error('Missing manifest.json in the package')
  const manifestText = new TextDecoder().decode(manifestBytes)
  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch {
    throw new Error('manifest.json is not valid JSON')
  }
  const parsed = safeParseExtensionManifest(raw)
  if (!parsed.ok) throw new Error(`Invalid manifest:\n- ${parsed.issues.join('\n- ')}`)
  const manifest = parsed.manifest
  requireAppPlatform(manifest, 'phone')
  if (manifest.contributes.tabs.some((tab) => tab.hostPage)) throw new Error('This App needs Gugu Desktop to configure and run its tools.')
  if (manifest.entry && !files.has(manifest.entry)) throw new Error(`The manifest's entry is not in the package: ${manifest.entry}`)
  for (const tab of manifest.contributes.tabs) {
    const entry = tab.entry ?? manifest.entry
    if (!entry || !files.has(entry)) throw new Error(`The tab's entry is not in the package: ${tab.name}`)
  }
  return { files, manifest, manifestDigest: await sha256(new TextEncoder().encode(manifestText)), sha256: digest }
}

/** Asked in the shell's sheet, as every install here is asked. */
async function askHere(request: InstallConsentAsk, manifest: ExtensionManifest) {
  const sheet = askInShell(installConsentPrompt(request, manifest), `${request.manifestDigest}:${Date.now()}`, INSTALL_CONSENT_HUMAN_WINDOW_MS)
  if (!sheet) throw new Error('No consent sheet in this window to ask the person with')
  return sheet
}

/**
 * #7290 A card's message and its bytes, read and signed as the person signed in here (the chat's own rules). The clients
 * are loaded when a card by its message is installed: this store is read long before anyone is signed in.
 */
const phonePackageReads: PackageReads = {
  async message(messageId) {
    const { chatDb } = await import('../../lib/supabase')
    const { data, error } = await chatDb.from('messages_view').select(PACKAGE_MESSAGE_SELECT).eq('id', messageId).maybeSingle()
    if (error) throw new Error(error.message)
    return (data as unknown as PackageMessageRow | null) ?? null
  },
  async open(source) {
    const { resolveAttachment } = await import('../../lib/attachmentBytes')
    const file = await resolveAttachment(source)
    return file.status === 'ready' ? file : null
  },
}

/**
 * An App package sent in a chat, installed on this phone — as `installAttachment` does on the desktop, with the same
 * answer and the same result: downloaded and fingerprinted here (what the card showed is never trusted), checked,
 * asked about when it asks for anything, then stored and served from its own origin.
 */
async function installAttachment(args: AttachmentPackage & { unasked?: boolean; consent?: InstallConsent }): Promise<Result<PhoneInstallOutcome | AttachmentInstallRefused | { installed: false; outcome: 'held' }>> {
  try {
    const found = await resolveAttachmentPackage(args, phonePackageReads)
    // The person behind the publisher the server vouches for (an agent's owner): who published these bytes (app-identity.ts).
    const publisher = await publisherOf(async (id) => (await readDisplayIdentities([id]))[0] ?? null, found.publisher)
    await writable()
    // 摩擦单 F66: nobody clicked, and it could be no update of an App here — not downloaded.
    if (args.unasked && !couldUpdateUnasked(publisher.id, Object.keys(index.installed).flatMap((id) => installedHere(id) ?? []))) {
      await found.file.dispose()
      return { success: true, data: { installed: false, outcome: 'held' } }
    }
    // A deadline, because the consent window only starts after this.
    const { files, manifest, manifestDigest, sha256: digest } = await readPackage(await packageBytes(found.file))
    const installed = installedHere(manifest.id)
    // Asked only about what this phone can grant (`grantableBy`): the rest is not on its pages' gugu, and a sheet about it
    // asks the person for nothing they could use here. The whole manifest is what is stored.
    const grantable = grantableBy(manifest, PHONE_CAPABILITIES)
    const before = installed && { ...installed, manifest: grantableBy(installed.manifest, PHONE_CAPABILITIES) }
    const plan = attachmentInstallPlan({ candidate: grantable, publisher: publisher.id, installed: before, unasked: args.unasked === true })
    const summary = { id: manifest.id, name: manifest.name, version: manifest.version, sha256: digest }
    // E-05: answered, not thrown — the card or the panel that was clicked says why to the person (`refusedLine`).
    if (plan.kind === 'refuse') {
      return { success: true, data: { installed: false, outcome: 'refused', ...summary, reason: plan.reason, from: plan.from, installedVersion: plan.installedVersion } }
    }
    if (plan.kind === 'held') return { success: true, data: { installed: false, outcome: 'held', ...summary } }
    const request: InstallConsentAsk = {
      manifest: grantable,
      manifestDigest,
      // Another publisher's under the same id is asked in full (摩擦单 F66): the plan says it replaces nothing it knows.
      installed: plan.kind === 'ask' ? plan.installed : before?.manifest,
      revokedPermissions: [...(plan.kind === 'ask' ? plan.revokedPermissions : before?.revokedPermissions ?? [])],
      attachment: { from: publisher.name ?? '', ...(plan.kind === 'ask' && plan.replaces !== undefined ? { replaces: plan.replaces } : {}) },
    }
    const done = await agreeThenInstall(request, plan.kind === 'ask', args.consent ?? { kind: 'here' }, () => askHere(request, grantable), () =>
      store(manifest, files, { publisher, sha256: digest, manifestDigest, origin: 'attachment' }))
    if (done.outcome === 'ask') return { success: true, data: { installed: false, outcome: 'ask', ...summary, ask: request, asks: plan.kind === 'ask' } }
    if (done.outcome !== 'confirmed') return { success: true, data: { installed: false, outcome: done.outcome, ...summary } }
    return { success: true, data: { installed: true, outcome: 'confirmed', ...summary, ...(installed ? { updatedFrom: installed.manifest.version } : {}) } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ package: `msg:${args.messageId}`, error: message }, 'App package from chat was not installed')
    return { success: false, error: message }
  }
}

/** What a market install answers, as main's installExtensionFromMarket does (an `ask` for `return`). */
export type PhoneMarketOutcome =
  | { installed: true; outcome: 'confirmed'; id: string; name: string; version: string; updatedFrom?: string }
  | { installed: false; outcome: 'ask'; id: string; name: string; version: string; ask: InstallConsentAsk; asks: boolean }
  | { installed: false; outcome: 'declined' | 'dismissed' | 'timeout'; id: string; name: string; version: string }

/** Where the index in hand is kept between runs (market-snapshot.ts): the page's own storage, as 「始终用它」 is. */
const MARKET_INDEX_KEY = 'gugu.marketIndex'

/**
 * The market as this phone reads it: through the shell (no CORS on the download site), for this build's version. The index
 * in hand is kept here, so the 「App」 page says 「更新到 vX」 the moment it opens and asks the download site behind it.
 */
const market = phoneMarket(
  async (relativePath, maxBytes) =>
    Uint8Array.from(atob((await appStore.marketRead({ path: relativePath, ...(maxBytes ? { maxBytes } : {}) })).base64), (char) => char.charCodeAt(0)),
  () => currentMarketHost(__APP_VERSION__, 'phone'),
  {
    read: async () => localStorage.getItem(MARKET_INDEX_KEY),
    write: async (text) => {
      try {
        localStorage.setItem(MARKET_INDEX_KEY, text)
      } catch (error) {
        // Not kept: the next run waits for the download site once, as a first run does.
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'The App market index could not be kept')
      }
    },
  },
  (error) => log.warn({ error: error instanceof Error ? error.message : String(error) }, 'App market index not refreshed; the one in hand stays'),
  (relativePath) => new URL(relativePath, feeds.market).href,
)

/** Packages read for an ask handed back (`return`), kept until the person's yes installs them (`given`): never fetched twice. */
const held = new Map<string, ReadPackage & { source: MarketCodeSource; releaseNotes: string }>()

/**
 * An App from the market, installed on this phone — the phone's side of main's installExtensionFromMarket, with its ways
 * to ask: here (none), handed back (`return`, always, `asks` false when there is nothing to agree to), agreed to already
 * (`given`: these bytes only, by their manifest digest), or nobody (`gugu`: gugu's own App put in by gugu itself, the
 * first-run set — only one whose code is in gugu's own repository, and only as a first install). Fetched through the shell and checked against the size
 * and sha256 the market recorded (phoneMarket.ts), read with the desktop's checks, asked about only what a phone can grant,
 * stored as the market's App (gugu's).
 */
async function installFromMarket(args: {
  ref: { extensionId: string; version?: string }
  consent?: Exclude<InstallConsent, { kind: 'here' }> | { kind: 'gugu' }
}): Promise<Result<PhoneMarketOutcome>> {
  try {
    await writable()
    const { extensionId } = args.ref
    const key = (version: string) => `${extensionId}@${version}`
    let pkg = args.consent?.kind === 'given' && args.ref.version ? held.get(key(args.ref.version)) : undefined
    if (!pkg) {
      const fetched = await market.fetch(extensionId, args.ref.version)
      pkg = { ...(await readPackage(fetched.bytes)), source: fetched.source, releaseNotes: fetched.releaseNotes }
      // What is in the package is what the market said it was: else the permissions read are not the ones on its card.
      if (pkg.manifest.id !== extensionId || pkg.manifest.version !== fetched.version) {
        throw new Error(`The package holds ${pkg.manifest.id}@${pkg.manifest.version}, not ${extensionId}@${fetched.version}`)
      }
    }
    const { manifest } = pkg
    const installed = installedHere(manifest.id)
    // E-05: what ships with gugu is gugu's; no package takes its id.
    if (installed?.origin === 'preinstalled') throw new Error(`"${manifest.id}" ships with gugu and cannot be replaced`)
    const grantable = grantableBy(manifest, PHONE_CAPABILITIES)
    const before = installed && grantableBy(installed.manifest, PHONE_CAPABILITIES)
    const { asks } = installAsks({ installed: before, installedOrigin: installed?.origin, revokedPermissions: [], candidate: grantable, origin: 'market' })
    const request: InstallConsentAsk = {
      manifest: grantable,
      manifestDigest: pkg.manifestDigest,
      installed: before,
      revokedPermissions: [],
      market: { source: pkg.source, releaseNotes: pkg.releaseNotes },
    }
    const summary = { id: manifest.id, name: manifest.name, version: manifest.version }
    if (args.consent?.kind === 'gugu') {
      // Nobody asked: so only gugu's own (its code in gugu's repository, the bytes checked against what the market published
      // from there), and never over an App here — its update asks as any update does.
      if (!isGuguOwnApp(pkg.source)) throw new Error(`${manifest.id} is not gugu's own App (its code is at ${pkg.source.repo}); only gugu's own go in without asking`)
      if (installed) throw new Error(`${manifest.id} is installed here already; it is not put in again without asking`)
      await store(manifest, pkg.files, { publisher: { id: GUGU_PUBLISHER }, sha256: pkg.sha256, manifestDigest: pkg.manifestDigest, origin: 'market' })
      return { success: true, data: { installed: true, outcome: 'confirmed', ...summary } }
    }
    const got = pkg
    const done = await agreeThenInstall(request, asks, args.consent ?? { kind: 'here' }, () => askHere(request, grantable), () =>
      store(manifest, got.files, { publisher: { id: GUGU_PUBLISHER }, sha256: got.sha256, manifestDigest: got.manifestDigest, origin: 'market' }))
    if (done.outcome === 'ask') {
      held.set(key(manifest.version), pkg)
      return { success: true, data: { installed: false, outcome: 'ask', ...summary, ask: request, asks } }
    }
    held.delete(key(manifest.version))
    if (done.outcome !== 'confirmed') return { success: true, data: { installed: false, outcome: done.outcome, ...summary } }
    // An older version than the market gives this phone, picked by the person: it stays, not updated by itself (as on the desktop).
    const offered = (await market.entries()).find((entry) => entry.manifest.id === extensionId)?.version ?? null
    if (pinsAutoUpdate(manifest.version, offered)) await writeAutoUpdate(extensionId, false)
    return { success: true, data: { installed: true, outcome: 'confirmed', ...summary, ...(installed ? { updatedFrom: installed.manifest.version } : {}) } }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn({ extensionId: args.ref.extensionId, error: message }, 'App from the market was not installed')
    return { success: false, error: message }
  }
}

/** The version lands under <id>@<version> in one rename, then the index points at it; the older one goes at the next start. */
async function store(
  manifest: ExtensionManifest,
  files: ReadonlyMap<string, Uint8Array>,
  meta: { publisher: Publisher; sha256: string; manifestDigest: string; origin: 'attachment' | 'market' },
): Promise<void> {
  const dir = `${manifest.id}@${manifest.version}`
  const stage = `stage-${hex(crypto.getRandomValues(new Uint8Array(8)).buffer)}`
  const pages: string[] = []
  try {
    for (const [path, data] of files) {
      // Every page of the App gets the runtime's line, as the desktop's protocol gives it to every page it serves.
      const out = HTML.test(path) ? new TextEncoder().encode(injectAppRuntime(new TextDecoder().decode(data))) : data
      if (HTML.test(path)) pages.push(path)
      await appStore.stage({ stage, path, base64: base64(out) })
    }
    await appStore.commit({ stage, dir })
  } catch (error) {
    await appStore.discard({ stage }).catch(() => undefined)
    throw error
  }
  const icons = await iconsOf(manifest, async (path) => files.get(path))
  index.installed[manifest.id] = {
    dir,
    manifest,
    publisher: meta.publisher,
    sha256: meta.sha256,
    manifestDigest: meta.manifestDigest,
    origin: meta.origin,
    installedAt: new Date().toISOString(),
    runtimeTag: RUNTIME_SCRIPT_TAG,
    pages,
    icons,
  }
  index.serve[manifest.id] = { root: `file:${dir}`, csp: cspOf(manifest) }
  await save()
  tell()
}

/**
 * What the market says about the Apps installed here from it — a newer version for this phone, a withdrawn one, a deprecated
 * App — from the index in hand (the settings page's 「更新到 vX」; the page asks the download site behind it). What is left here
 * after `autoUpdate` is what asks the person for more, and what they keep at an older version (VS Code shows those too).
 */
async function marketUpdates(): Promise<Result<MarketUpdatesSummary>> {
  try {
    await ready()
    const fromMarket = Object.values(index.installed)
      .filter((record) => record.origin === 'market')
      .map((record) => ({ id: record.manifest.id, version: record.manifest.version, fromMarket: true }))
    if (fromMarket.length === 0) return { success: true, data: { checkedAt: new Date().toISOString(), updates: {}, yanked: {}, deprecated: {}, gone: [] } }
    return { success: true, data: await market.updatesFor(fromMarket) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The market Apps installed here, switched on, 「自动更新」 on, go to the version the market gives this phone — as on the desktop
 * (auto-update-apps.ts; owner 10-19, VS Code's auto update). One that would ask the person (it asks for more) waits for their
 * 「更新」; the update is the one 「更新」 runs (`installFromMarket`, `return` then `given` on these bytes). Each on its own.
 */
async function autoUpdateOnce(): Promise<void> {
  const off = new Set(index.autoUpdateOff ?? [])
  const disabled = new Set(index.disabled ?? [])
  const eligible = Object.values(index.installed)
    .filter((record) => record.origin === 'market' && !disabled.has(record.manifest.id) && !off.has(record.manifest.id))
    .map((record) => ({ id: record.manifest.id, version: record.manifest.version }))
  if (eligible.length === 0) return
  const offers = await market.entries()
  for (const update of autoUpdatesFrom(await market.updatesFor(eligible), eligible)) {
    const ref = { extensionId: update.id, version: update.version }
    const installed = installedHere(update.id)
    const offered = offers.find((entry) => entry.manifest.id === update.id && entry.version === update.version)
    // Read off the index's copy of its manifest first: one that would ask is not downloaded for nothing at every start.
    if (installed && offered && installAsks({
      installed: grantableBy(installed.manifest, PHONE_CAPABILITIES), installedOrigin: installed.origin, revokedPermissions: [],
      candidate: grantableBy(offered.manifest, PHONE_CAPABILITIES), origin: 'market',
    }).asks) {
      log.info(update, 'auto-update: waits for the person (it asks for more)')
      continue
    }
    const handed = await installFromMarket({ ref, consent: { kind: 'return' } })
    if (!handed.success) continue
    if (handed.data.outcome !== 'ask' || handed.data.asks) {
      log.info({ ...update, outcome: handed.data.outcome }, 'auto-update: waits for the person')
      continue
    }
    const done = await installFromMarket({ ref, consent: { kind: 'given', digest: handed.data.ask.manifestDigest } })
    if (done.success && done.data.installed) log.info(update, 'auto-update: updated')
  }
}

let autoUpdating: Promise<void> | null = null
let autoUpdateAgain = false

/** A pass, never two at once: asked while one runs, one more runs after it. */
function autoUpdate(): Promise<void> {
  if (autoUpdating) {
    autoUpdateAgain = true
    return autoUpdating
  }
  autoUpdating = (async () => {
    do {
      autoUpdateAgain = false
      await autoUpdateOnce().catch((error: unknown) => log.warn({ error: error instanceof Error ? error.message : String(error) }, 'auto-update: the pass stopped'))
    } while (autoUpdateAgain)
  })().finally(() => {
    autoUpdating = null
  })
  return autoUpdating
}

async function writeAutoUpdate(id: string, on: boolean): Promise<void> {
  const off = new Set(index.autoUpdateOff ?? [])
  if (on) off.delete(id)
  else off.add(id)
  index.autoUpdateOff = [...off]
  await save()
  tell()
}

/** An App's 「自动更新」 (owner 10-19): only a market App installed here has one. Back on, it is updated at once (as VS Code does). */
async function setAutoUpdate(id: string, on: boolean): Promise<Result<null>> {
  try {
    await writable()
    if (index.installed[id]?.origin !== 'market') throw new Error(`"${id}" is not an App from the market installed here`)
    await writeAutoUpdate(id, on)
    if (on) void autoUpdate()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** How long an origin has to say it forgot (it only clears its own storage): past it, the uninstall goes on regardless. */
const FORGET_WINDOW_MS = 10_000

/**
 * What the App kept in its origin — localStorage, IndexedDB, caches, cookies — forgotten where it is: the platform's
 * forget page (forget-entry.ts) opened in that origin, which clears and says so. Done while the shell still serves the
 * App's origin (before the index lets it go).
 */
function forgetOrigin(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const frame = document.createElement('iframe')
    frame.hidden = true
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
    const channel = appFrameChannel(frame)
    const done = () => {
      window.removeEventListener('message', heard)
      clearTimeout(late)
      frame.remove()
      resolve()
    }
    const heard = (event: MessageEvent) => {
      if (channel.accepts(event)) done()
    }
    const late = setTimeout(() => {
      log.warn({ id }, 'an App origin did not say it forgot its storage; uninstalling anyway')
      done()
    }, FORGET_WINDOW_MS)
    window.addEventListener('message', heard)
    frame.src = `${appOrigin(id)}${APP_RUNTIME_FORGET_PAGE}`
    document.body.append(frame)
  })
}

/** Removed from this phone: its files, and what it stored in its own origin goes with the origin (never the group's files). */
async function uninstall(id: string): Promise<Result<null>> {
  try {
    await writable()
    if (shipped.some((manifest) => manifest.id === id)) throw new Error(`"${id}" is a preinstalled App and cannot be uninstalled.`)
    const record = index.installed[id]
    if (!record) throw new Error(`"${id}" is not installed`)
    // What it kept for itself goes with it — its origin's storage and its data folder — as on the desktop
    // (摩擦单 F67: the sheet says so): a reinstall starts empty.
    await forgetOrigin(id)
    delete index.installed[id]
    delete index.serve[id]
    // "Off" was about something no longer here: a reinstall arrives switched on (as the desktop's uninstall).
    index.disabled = (index.disabled ?? []).filter((one) => one !== id)
    index.autoUpdateOff = (index.autoUpdateOff ?? []).filter((one) => one !== id)
    await save()
    await appStore.discard({ dir: record.dir })
    await appStore.dataRemove({ app: id })
    tell()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Switched off or back on — the desktop's `setEnabled`, the same refusals: an App gugu ships (the 群文件夹, the ground every
 * chat's files sit in) cannot be switched off, and one not installed here has no switch.
 */
async function setEnabled(id: string, enabled: boolean): Promise<Result<null>> {
  try {
    await writable()
    if (shipped.some((manifest) => manifest.id === id)) throw new Error(`"${id}" is a preinstalled App and cannot be switched off.`)
    if (!index.installed[id]) throw new Error(`"${id}" is not installed`)
    const disabled = new Set(index.disabled ?? [])
    if (enabled) disabled.delete(id)
    else disabled.add(id)
    index.disabled = [...disabled]
    await save()
    tell()
    return { success: true, data: null }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The person ticked 「始终用它」 (or took it back with null): kept in this page (the picker notes the store's copy). */
function setOpenWithDefault(args: { key: string; tabKind: string | null }): Result<null> {
  try {
    const all = rememberedAll()
    if (args.tabKind === null) delete all[args.key]
    else all[args.key] = args.tabKind
    localStorage.setItem(OPEN_WITH_KEY, JSON.stringify(all))
  } catch {
    // Not kept: the next time asks again.
  }
  return { success: true, data: null }
}

/**
 * Where an App's page is: its own origin (appOrigin.ts — never this page's, which is what makes `allow-same-origin` on
 * its frame harmless), and the page (`entry`, or a tab's own).
 */
function pageUrl(appId: string, page: string): string {
  return `${appOrigin(appId)}/${page.replace(/^\/+/, '')}`
}

/**
 * An App's own data folder (`gugu.readData` / `writeData` / `listData`): the desktop's verbs, limit and answers (a file
 * not there reads as null); kept by the shell under the App.
 */
const data = {
  async read(appId: string, path: string): Promise<string | null> {
    return (await appStore.dataRead({ app: appId, path })).text
  },
  async write(appId: string, path: string, content: string): Promise<void> {
    const tooLarge = appDataTooLarge(new TextEncoder().encode(content).byteLength)
    if (tooLarge) throw new Error(tooLarge)
    await appStore.dataWrite({ app: appId, path, text: content })
  },
  async list(appId: string, dir: string): Promise<{ path: string; kind: 'file' | 'directory' }[]> {
    return (await appStore.dataList({ app: appId, path: dir || '.' })).entries
  },
}

/** The first-run set's record on this phone, kept in the App store index (the desktop keeps it in main). */
const firstRun = {
  async get(): Promise<Result<FirstRunRecord>> {
    try {
      await ready()
      return { success: true, data: index.firstRun ?? { state: 'existing' } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
  async set(record: FirstRunRecord): Promise<Result<null>> {
    try {
      await writable()
      index.firstRun = firstRunRecordSchema.parse(record)
      await save()
      return { success: true, data: null }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
}

export const phoneApps = {
  ready,
  reload,
  /** Why this page load could not read the list of Apps here (null: it could); nothing is changed until it can. */
  unreadable: (): string | null => unreadable,
  firstRun,
  installAttachment,
  installFromMarket,
  market,
  marketUpdates,
  /** Where an App installed here came from: from the market, or from a chat (null: not installed here). */
  originOf: (id: string): 'attachment' | 'market' | null => {
    const record = index.installed[id]
    return record ? (record.origin ?? 'attachment') : null
  },
  uninstall,
  setEnabled,
  setAutoUpdate,
  setOpenWithDefault,
  remembered: (key: string): string | null => rememberedAll()[key] ?? null,
  pageUrl,
  data,
  /** Every App on this phone that is not shipped: the ones the person can uninstall. */
  installedFromChats: (): ExtensionManifest[] => Object.values(index.installed).map((record) => record.manifest),
}
