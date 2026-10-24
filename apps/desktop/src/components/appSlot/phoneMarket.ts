import { compatOf, pickForHost, type CloudMarketEntry, type MarketCodeSource, type MarketHost, type MarketIndex, type MarketIndexVersion, type MarketUpdatesSummary, type MarketVersionHistoryEntry } from '../../session/shared/extensions/market'
import { marketEntriesFrom, marketHistoryFrom, marketUpdatesFrom } from '../../session/shared/extensions/market-entries'
import { marketSnapshotSource, type MarketRefreshed, type MarketSnapshotStore } from '../../session/shared/extensions/market-snapshot'
import { appPlatformDeclarationProblems, requireAppPlatform } from '../../session/shared/extensions/app-platforms'

/**
 * The App market as the phone reads it (L9; 161 10-15: the phone installs market Apps). The same `market/index.json` the
 * desktop reads, read through the shell (`read`: GuguAppStore.marketRead — the download site sends no CORS headers, so the
 * page cannot read it itself), and the same answers from it: which version this phone gets (`pickForHost`), what to tell
 * about what is installed (`marketUpdatesFrom`), every card (`marketEntriesFrom`). A package is checked against the size and
 * sha256 its row recorded before anything else reads it — as main does before unpacking (market-catalog.ts `materialize`).
 * The index in hand is the desktop's too (market-snapshot.ts, kept where `store` keeps it): the 「App」 page answers from it at
 * once and asks the download site behind it; an install takes the index now.
 */

/** A version fetched from the market, checked: its bytes, and what its row says about it. */
export interface MarketPackage {
  bytes: Uint8Array
  version: string
  sha256: string
  source: MarketCodeSource
  releaseNotes: string
}

export interface PhoneMarket {
  /** Every App the market offers this phone (the index taken now when `fresh`, else the one in hand). */
  entries(fresh?: boolean): Promise<(CloudMarketEntry & { firstPublishedAt: string })[]>
  /** This published version's README, including its market screenshot URLs. */
  readme(extensionId: string, version: string): Promise<string | null>
  /** Every version of one App, newest first, each with whether this phone can install it — the desktop's version history. */
  history(extensionId: string): Promise<MarketVersionHistoryEntry[]>
  /** Updates, withdrawn versions, deprecations for these installed Apps — from the index in hand. */
  updatesFor(installed: readonly { id: string; version: string; fromMarket?: boolean }[]): Promise<MarketUpdatesSummary>
  /** One version — this phone's when none is named — fetched and checked; what cannot be installed says why. */
  fetch(extensionId: string, version?: string): Promise<MarketPackage>
  /** Ask the download site for the index once, and say what came of it (changed / unchanged / failed): the 「App」 page's. */
  refresh(): Promise<MarketRefreshed>
  /** Every time the index was asked for, by whoever (the page, an install). Returns the unsubscribe. */
  onRefreshed(listener: (refreshed: MarketRefreshed) => void): () => void
}

export function phoneMarket(
  read: (relativePath: string, maxBytes?: number) => Promise<Uint8Array>,
  host: () => MarketHost,
  store: MarketSnapshotStore,
  onRefreshFailure?: (error: unknown) => void,
  urlOf: (relativePath: string) => string = (relativePath) => relativePath,
): PhoneMarket {
  const snapshot = marketSnapshotSource({ readIndex: async () => new TextDecoder().decode(await read('index.json')), store, onFailure: onRefreshFailure })
  const index = async (fresh: boolean): Promise<MarketIndex> => (await (fresh ? snapshot.fresh() : snapshot.current())).index
  return {
    entries: async (fresh = false) => {
      const apps = (await index(fresh)).apps
      const first = new Map(apps.map((app) => [app.id, app.versions.map((version) => version.publishedAt).sort()[0] ?? '']))
      return marketEntriesFrom(apps, host(), urlOf).extensions.map((entry) => ({ ...entry, firstPublishedAt: first.get(entry.manifest.id) ?? entry.publishedAt }))
    },
    readme: async (extensionId, version) => {
      const path = (await index(false)).apps.find((app) => app.id === extensionId)?.versions.find((entry) => entry.version === version)?.readme
      return path ? new TextDecoder().decode(await read(path)) : null
    },
    history: async (extensionId) => marketHistoryFrom((await index(false)).apps.find((app) => app.id === extensionId) ?? null, host()),
    updatesFor: async (installed) => marketUpdatesFrom(await index(false), host(), installed, new Date().toISOString()),
    refresh: () => snapshot.refresh(),
    onRefreshed: (listener) => snapshot.onRefreshed(listener),
    fetch: async (extensionId, version) => {
      const app = (await index(true)).apps.find((entry) => entry.id === extensionId)
      if (!app) throw new Error(`The market has no App "${extensionId}"`)
      const row: MarketIndexVersion | null = version
        ? (app.versions.find((entry) => entry.version === version) ?? null)
        : pickForHost(app.versions.filter((entry) => appPlatformDeclarationProblems(entry.manifest, 'phone').length === 0), host()).chosen
      if (!row) throw new Error(`${extensionId}${version ? `@${version}` : ''} is no longer available in the market`)
      if (row.yanked) throw new Error(`${extensionId}@${row.version} was withdrawn: ${row.yanked.reason}`)
      requireAppPlatform(row.manifest, 'phone')
      const compat = compatOf(row, host())
      if (compat) {
        throw new Error(
          compat.reason === 'needs-newer-app'
            ? `${extensionId}@${row.version} needs gugu ${compat.minAppVersion} or newer`
            : `${extensionId}@${row.version} is written for an App interface this gugu no longer runs`,
        )
      }
      // No more than the row says it is: the shell stops a bigger one while it comes (it is held in memory whole, twice).
      const bytes = await read(row.bundle, row.bytes)
      if (bytes.byteLength !== row.bytes) throw new Error(`${extensionId}@${row.version}: got ${bytes.byteLength} bytes, the market recorded ${row.bytes}`)
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
      // Consent binds a manifest, not code: anyone able to swap the file on the download site could put other code under
      // a list of permissions already agreed to. This is what stops that.
      if (sha256 !== row.sha256) throw new Error(`${extensionId}@${row.version}: the file does not match what was published`)
      return { bytes, version: row.version, sha256, source: row.source, releaseNotes: row.releaseNotes }
    },
  }
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
