import { chatDb } from '@/lib/supabase'
import { rendererLogger } from '@/lib/log'
import { featuredOf, marketHome, popularOf, type CloudMarketEntry, type MarketListItem } from '@/session/shared/extensions/market'
import { searchApps } from '@/session/shared/extensions/app-search'
import { marketCategoryOf, marketCategoryRank } from '@/session/shared/extensions/catalog'
import type { ProductPageApi } from '@/session/renderer/features/extensions/panel/app-product-page'
import { phoneApps } from '../appSlot/phoneApps'

const log = rendererLogger('app-slot/phone-market-page')

/** Only transport differs: the same catalog and home/search rules as the desktop. */
export async function readPhoneMarketPage() {
  const [entries, ranking] = await Promise.all([phoneApps.market.entries(), chatDb.rpc('market_install_ranking')])
  if (ranking.error) log.warn({ error: ranking.error.message }, 'App market install ranking unreadable')
  const scores = new Map(((ranking.data ?? []) as { app_id: string; score: number }[]).map((row) => [row.app_id, row.score]))
  const home = marketHome(entries)
  return {
    entries,
    featured: featuredOf(entries, scores).map(marketItem),
    home: {
      newest: home.newest.map(marketItem),
      popular: popularOf(entries, scores).map(marketItem),
      shelves: home.shelves.map(({ category, entries }) => ({ category, items: entries.map(marketItem) })),
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
