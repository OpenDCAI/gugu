import { compareExtensionVersions, type ExtensionManifest } from '../../session/shared/extensions/manifest'
import type { ExtensionOrigin } from '../../session/shared/extensions/upgrade'
import type { PackageCard, SharedPackage } from './sharedPackages'

/** A market App's installable version on this device. */
export interface MarketOffer {
  manifest: ExtensionManifest
  version: string
}

export interface AppInstallOffer {
  manifest: ExtensionManifest
  from: { kind: 'shared'; card: PackageCard } | { kind: 'market'; extensionId: string; version: string }
}

/** File and widget offers share the group's own package first, and only versions newer than what is here. */
export function availableInstallOffers(shared: ReadonlyMap<string, SharedPackage>, market: readonly MarketOffer[], installed: readonly ExtensionManifest[], origins: Readonly<Record<string, ExtensionOrigin>>): AppInstallOffer[] {
  const notHere = (manifest: ExtensionManifest) => {
    const mine = installed.find(candidate => candidate.id === manifest.id)
    return !mine || compareExtensionVersions(mine.version, manifest.version) < 0
  }
  return [
    ...[...shared.values()].filter(pkg => notHere(pkg.manifest)).map(pkg => ({ manifest: pkg.manifest, from: { kind: 'shared' as const, card: pkg.card } })),
    ...market.filter(entry => origins[entry.manifest.id] !== 'fork' && notHere(entry.manifest) && !shared.has(entry.manifest.id))
      .map(entry => ({ manifest: entry.manifest, from: { kind: 'market' as const, extensionId: entry.manifest.id, version: entry.version } })),
  ]
}

/** A widget can only offer its exact App and declared view on this device's platform. */
export function widgetInstallOffer(offers: readonly AppInstallOffer[], app: string, view: string, platform: 'desktop' | 'phone'): AppInstallOffer | null {
  return offers.find(({ manifest }) => manifest.id === app && (!manifest.platforms || manifest.platforms.includes(platform))
    && manifest.contributes.tabs.some(tab => tab.name === view && tab.widget)) ?? null
}
