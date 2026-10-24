import { describe, expect, it, vi } from 'vitest'
import { phoneMarket } from '../../../../apps/desktop/src/components/appSlot/phoneMarket'
import { currentMarketHost } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

function catalog() {
  const version = (version: string, publishedAt: string, readme: string | null) => ({
    version, publishedAt, readme,
    manifest: { id: 'notes', name: 'Notes', version, apiVersion: EXTENSION_API_VERSION, platforms: ['phone'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } },
    apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: '', sha256: 'a'.repeat(64), bytes: 10,
    bundle: `notes/${version}/app.guguext`, icon: `notes/${version}/icon.png`, source: { repo: 'owner/apps', path: 'notes', commit: 'a'.repeat(40) }, yanked: null,
  })
  return { version: 1, apps: [{ id: 'notes', deprecated: null, featured: true, versions: [version('2.0.0', '2026-10-20T00:00:00Z', 'notes/2.0.0/README.md'), version('1.0.0', '2026-09-01T00:00:00Z', null)] }] }
}

function market() {
  const read = vi.fn(async (path: string) => new TextEncoder().encode(path === 'index.json' ? JSON.stringify(catalog()) : '# Notes\n![Preview](https://example.org/preview.png)'))
  return {
    read,
    market: phoneMarket(read, () => currentMarketHost('9.0.0', 'phone'), { read: async () => null, write: async () => undefined }, undefined, (path) => `https://example.org/market/${path}`),
  }
}

describe('the phone market supplies the shared browsing and product components', () => {
  it('uses the selected version for the icon and retains the first release date for New', async () => {
    const { market: source } = market()
    expect(await source.entries()).toMatchObject([{ version: '2.0.0', firstPublishedAt: '2026-09-01T00:00:00Z', iconUrl: 'https://example.org/market/notes/2.0.0/icon.png' }])
  })

  it('reads only the requested published README and never downloads the package to browse it', async () => {
    const { market: source, read } = market()
    expect(await source.readme('notes', '2.0.0')).toContain('https://example.org/preview.png')
    expect(read.mock.calls.map(([path]) => path)).toEqual(['index.json', 'notes/2.0.0/README.md'])
    expect(await source.readme('notes', '1.0.0')).toBeNull()
    expect(await source.readme('absent', '1.0.0')).toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reports a failed README read rather than caching it as an absent screenshot', async () => {
    const { market: source, read } = market()
    await source.entries()
    read.mockRejectedValueOnce(new Error('offline'))
    await expect(source.readme('notes', '2.0.0')).rejects.toThrow('offline')
  })
})
