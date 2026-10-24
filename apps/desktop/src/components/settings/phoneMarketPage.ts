import { chatDb } from '@/lib/supabase'
import { rendererLogger } from '@/lib/log'
import type { CloudMarketEntry, MarketListItem } from '@/session/shared/extensions/market'
import { marketHome } from '@/session/shared/extensions/market-home'
import { searchApps } from '@/session/shared/extensions/app-search'
import { marketCategoryOf, marketCategoryRank } from '@/session/shared/extensions/catalog'
import type { ProductPageApi } from '@/session/renderer/features/extensions/panel/app-product-page'
import { phoneApps } from '../appSlot/phoneApps'

const log = rendererLogger('app-slot/phone-market-page')

/** Only transport differs: the same catalog and home/search rules as the desktop. */
export async function readPhoneMarketPage() {
  const ranking = Promise.resolve(chatDb.rpc('market_install_ranking')).then(({ data, error }) => {
    if (error) throw error
    return new Map(((data ?? []) as { app_id: string; score: number }[]).map((row) => [row.app_id, row.score]))
  }).catch((error: unknown) => {
    log.warn({ error: String(error) }, 'App market install ranking unreadable')
    return null
  })
  const [entries, scores] = await Promise.all([phoneApps.market.entries(), ranking])
  const home = marketHome(entries, scores)
  return {
    entries,
    featured: home.featured.map(marketItem),
    home: {
      remaining: home.remaining.map(marketItem),
      newest: home.newest.map(marketItem),
      popular: home.popular === null ? null : home.popular.map(marketItem),
    },
  }
}

export function phoneMarketRows(entries: Awaited<ReturnType<typeof phoneApps.market.entries>>, query: string): MarketListItem[] {
  const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]))
  const records = entries.map((entry) => ({ ...entry, state: 'market' as const }))
  return searchApps(records, { query }).items.map((record) => marketItem(byId.get(record.manifest.id)!)).sort((a, b) =>
    marketCategoryRank(marketCategoryOf(a.manifest)) - marketCategoryRank(marketCategoryOf(b.manifest)) ||
    a.manifest.name.localeCompare(b.manifest.name) || a.manifest.id.localeCompare(b.manifest.id),
  )
}

function marketItem({ manifest, ...cloud }: CloudMarketEntry): MarketListItem {
  return { manifest, cloud, ref: { extensionId: manifest.id, version: cloud.version } }
}

export const phoneProductApi: ProductPageApi = {
  marketReadme: async ({ extensionId, version }) => {
    try {
      return { success: true, data: { readme: await phoneApps.market.readme(extensionId, version) } }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },
  marketHistory: async ({ extensionId }) => {
    try {
      return { success: true, data: await phoneApps.market.history(extensionId) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },
}
