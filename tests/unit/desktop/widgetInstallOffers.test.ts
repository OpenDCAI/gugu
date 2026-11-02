import { describe, expect, it } from 'vitest'
import { availableInstallOffers, widgetInstallOffer } from '../../../apps/desktop/src/components/extensionBundle/installOffers'
import type { ExtensionManifest } from '../../../apps/desktop/src/session/shared/extensions/manifest'
import type { SharedPackage } from '../../../apps/desktop/src/components/extensionBundle/sharedPackages'

const manifest = (version: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest => ({ id: 'vote', name: 'Vote', version,
  contributes: { tabs: [{ name: 'main', title: 'Vote', entry: 'index.html', widget: { height: 200 } }] }, ...extra } as ExtensionManifest)
const card = { messageId: 'package-message', source: { kind: 'message' as const, messageId: 'package-message' } }
const shared = (m = manifest('2.0.0')) => new Map<string, SharedPackage>([['vote', { manifest: m, card }]])
const market = [{ manifest: manifest('3.0.0'), version: '3.0.0' }]

describe('the shared file/widget install offer rules', () => {
  it('uses the group package instead of a higher market version', () => {
    expect(availableInstallOffers(shared(), market, [], {})).toEqual([{ manifest: manifest('2.0.0'), from: { kind: 'shared', card } }])
  })
  it.each(['2.0.0', '3.0.0'])('does not offer a shared version at or below installed %s', version => {
    expect(availableInstallOffers(shared(), market, [manifest(version)], {})).toEqual([])
  })
  it('offers the existing market version only without a group package, and excludes forks', () => {
    expect(availableInstallOffers(new Map(), market, [], {})).toMatchObject([{ from: { kind: 'market', extensionId: 'vote', version: '3.0.0' } }])
    expect(availableInstallOffers(new Map(), market, [manifest('1.0.0')], { vote: 'fork' })).toEqual([])
  })
  it('only offers the exact App id and a declared widget view on this platform', () => {
    const offers = availableInstallOffers(shared(), [], [], {})
    expect(widgetInstallOffer(offers, 'vote', 'main', 'desktop')?.from).toEqual({ kind: 'shared', card })
    expect(widgetInstallOffer(offers, 'Vote', 'main', 'desktop')).toBeNull()
    expect(widgetInstallOffer(offers, 'vote', 'other', 'desktop')).toBeNull()
    const phone = availableInstallOffers(shared(manifest('2.0.0', { platforms: ['phone'] })), [], [], {})
    expect(widgetInstallOffer(phone, 'vote', 'main', 'desktop')).toBeNull()
    expect(widgetInstallOffer(phone, 'vote', 'main', 'phone')).not.toBeNull()
    const plain = availableInstallOffers(shared(manifest('2.0.0', { contributes: { tabs: [{ name: 'main', title: 'Vote', entry: 'index.html' }] } as ExtensionManifest['contributes'] })), [], [], {})
    expect(widgetInstallOffer(plain, 'vote', 'main', 'desktop')).toBeNull()
  })
})
