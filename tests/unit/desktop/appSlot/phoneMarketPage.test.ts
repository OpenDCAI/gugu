import { describe, expect, it, vi } from 'vitest'
import { phoneMarket } from '../../../../apps/desktop/src/components/appSlot/phoneMarket'
import { currentMarketHost, type CloudMarketEntry } from '../../../../apps/desktop/src/session/shared/extensions/market'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

function catalog() {
  const version = (version: string, publishedAt: string) => ({
    version, publishedAt,
    manifest: { id: 'notes', name: 'Notes', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['phone'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } },
    apiVersion: EXTENSION_API_VERSION, minAppVersion: '0.1.0', releaseNotes: '', sha256: 'a'.repeat(64), bytes: 10,
    bundle: `notes/${version}/app.guguext`, icon: `notes/${version}/icon.png`, source: { repo: 'owner/apps', path: 'notes', commit: 'a'.repeat(40) }, yanked: null,
  })
  return { version: 1, apps: [{ id: 'notes', deprecated: null, featured: true, versions: [version('2.0.0', '2026-10-20T00:00:00Z'), version('1.0.0', '2026-09-01T00:00:00Z')] }] }
}

function market() {
  const metas: Record<string, unknown> = {
    'meta/notes/2.0.0.json': { about: { en: 'Notes, kept.' }, screenshots: ['media/notes/preview.png'], releaseNotes: '' },
    'meta/notes/1.0.0.json': { releaseNotes: '', readme: null },
  }
  const read = vi.fn(async (path: string) => {
    if (path === 'index.json') return new TextEncoder().encode(JSON.stringify(catalog()))
    if (!(path in metas)) throw new Error(`404 ${path}`)
    return new TextEncoder().encode(JSON.stringify(metas[path]))
  })
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

  it('reads only the requested version\'s store listing and never downloads the package to browse it', async () => {
    const { market: source, read } = market()
    expect(await source.listing('notes', '2.0.0')).toEqual({ about: { en: 'Notes, kept.' }, screenshots: ['https://example.org/market/media/notes/preview.png'] })
    expect(read.mock.calls.map(([path]) => path)).toEqual(['meta/notes/2.0.0.json'])
    await expect(source.listing('notes', '1.0.0')).rejects.toThrow(/notes@1\.0\.0 has no store listing/)
  })

  it('reports a failed read rather than caching it as an absent listing', async () => {
    const { market: source, read } = market()
    read.mockRejectedValueOnce(new Error('offline'))
    await expect(source.listing('notes', '2.0.0')).rejects.toThrow('offline')
  })
})

const page = vi.hoisted(() => ({
  entries: vi.fn<() => Promise<CloudMarketEntry[]>>(),
  ranking: vi.fn<() => Promise<{ data: { app_id: string; score: number }[] | null; error: { message: string } | null }>>(),
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/phoneApps', () => ({ phoneApps: { market: { entries: page.entries } } }))
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: page.ranking } }))
const { readPhoneMarketPage, phoneMarketRows, keptPhoneMarketPage } = await import('../../../../apps/desktop/src/components/settings/phoneMarketPage')

describe('the phone calls the shared home selection with its catalog and ranking', () => {
  const ids = (items: { manifest: { id: string } }[]) => items.map((item) => item.manifest.id)
  async function entries() {
    const [notes] = await market().market.entries()
    const other = { ...notes!, manifest: { ...notes!.manifest, id: 'other', name: 'Other', contributes: { tabs: [{ name: 'main', title: 'Other' }] } }, featured: false, firstPublishedAt: '2026-10-22T00:00:00Z' }
    page.entries.mockResolvedValue([notes!, other])
    return [notes!, other]
  }

  it('keeps all Apps in complete browse results and shows each once in recommendations', async () => {
    const all = await entries()
    page.ranking.mockResolvedValue({ data: [{ app_id: 'other', score: 4 }], error: null })
    const result = await readPhoneMarketPage()
    expect(ids(result.featured)).toEqual(['other', 'notes'])
    expect(result.home.remaining).toEqual([])
    expect(ids(result.home.newest)).toEqual(['other', 'notes'])
    expect(ids(result.home.popular!)).toEqual(['other'])
    expect(ids(phoneMarketRows(all, 'notes'))).toEqual(['notes'])
  })

  it('retains a failed ranking as unavailable, distinct from a successful empty ranking', async () => {
    await entries()
    page.ranking.mockResolvedValue({ data: null, error: { message: 'denied' } })
    const failed = await readPhoneMarketPage()
    expect(failed.home.popular).toBeNull()
    expect(ids(failed.featured)).toEqual(['notes'])
    expect(ids(failed.home.remaining)).toEqual(['other'])
    page.ranking.mockResolvedValue({ data: [], error: null })
    expect((await readPhoneMarketPage()).home.popular).toEqual([])
  })

  it('preserves a transport failure as unavailable too', async () => {
    await entries()
    page.ranking.mockRejectedValueOnce(new Error('offline'))
    expect((await readPhoneMarketPage()).home.popular).toBeNull()
  })

  // 重启后第一帧(owner 10-30):上次画出来的那一页从 localStorage 同步读回来,❌ 先等排名那一趟网络、画骨架。
  it('keeps the page it drew for the next start, each App stored once', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) })
    try {
      expect(keptPhoneMarketPage()).toBeUndefined()
      await entries()
      page.ranking.mockResolvedValue({ data: [{ app_id: 'other', score: 4 }], error: null })
      const drawn = await readPhoneMarketPage()
      expect(keptPhoneMarketPage()).toEqual(drawn)
      // 推荐那几排只记 id:每个 App 的 manifest 在存下的那一份里只出现一次。
      const [kept] = [...stored.values()]
      expect(kept!.split('"name":"Other"').length - 1).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
