import { searchApps } from './app-search';
import { FEATURED_COUNT, type CloudMarketEntry } from './market';

type HomeEntry = Pick<CloudMarketEntry, 'manifest' | 'version' | 'publishedAt' | 'firstPublishedAt' | 'featured' | 'firstRun' | 'deprecated' | 'compat'>;

export interface MarketHome<T> {
  featured: T[];
  remaining: T[];
  newest: T[];
  /** null means the ranking could not be read; an empty list means no qualifying installs. */
  popular: T[] | null;
}

/** One selection for the recommendation page and its complete New / Popular browsing pages. */
export function marketHome<T extends HomeEntry>(entries: readonly T[], scores: ReadonlyMap<string, number> | null): MarketHome<T> {
  for (const entry of entries) {
    if (typeof entry.firstPublishedAt !== 'string' || !entry.firstPublishedAt) {
      throw new Error(`Market App ${entry.manifest.id} has no first publication date`);
    }
  }
  const eligible = entries.filter((entry) => !entry.deprecated && !entry.compat);
  const scoreOf = (entry: T) => scores?.get(entry.manifest.id) ?? 0;
  const ranked = eligible
    .filter((entry) => scoreOf(entry) > 0)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || a.manifest.id.localeCompare(b.manifest.id));
  const featured = ranked.filter((entry) => !entry.firstRun).slice(0, FEATURED_COUNT);
  for (const entry of eligible) {
    if (featured.length >= FEATURED_COUNT) break;
    if (entry.featured && !entry.firstRun && !featured.includes(entry)) featured.push(entry);
  }

  const byId = new Map(entries.map((entry) => [entry.manifest.id, entry]));
  const newest = searchApps(
    entries.map((entry) => ({ manifest: entry.manifest, state: 'market' as const, version: entry.version, publishedAt: entry.publishedAt, firstPublishedAt: entry.firstPublishedAt })),
    { sort: 'newest' }
  ).items.map((record) => byId.get(record.manifest.id)!);
  const featuredIds = new Set(featured.map((entry) => entry.manifest.id));
  return {
    featured,
    remaining: newest.filter((entry) => !entry.deprecated && !entry.compat && !featuredIds.has(entry.manifest.id)),
    newest,
    popular: scores === null ? null : ranked,
  };
}
