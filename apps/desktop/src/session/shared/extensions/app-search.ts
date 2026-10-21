import { appSearchText, CAPABILITY_RISK, NETWORK_RISK, type PermissionRisk } from './catalog';
import type { ExtensionManifest } from './manifest';
import { queryScore, queryWords } from './query-score';

/*
 * Finding an App (owner 10-19「想想怎么多维度,分页筛选,要认真做了」): one pure function for the agent's app_search and the
 * Apps page's search box and rows, ❌ a second copy in either. It filters, scores, sorts and counts; paging is the caller's
 * (the agent's list-window, the page's own scroll). Records are what is in hand — the installed Apps and the market index
 * the computer holds — never a request of its own.
 */

/** What this session can do with an App now: installed (on, switched off, not given to this agent, unusable) or only in the market. */
export const APP_SEARCH_STATES = ['on', 'off', 'not_given', 'unavailable', 'market'] as const;
export type AppSearchState = (typeof APP_SEARCH_STATES)[number];

/** An App's risk is its loudest declared permission (catalog.ts's two tiers); `none` = it declares none. */
export const APP_RISKS = ['none', 'medium', 'high'] as const;
export type AppRisk = 'none' | PermissionRisk;

export const APP_SEARCH_SORTS = ['relevance', 'newest', 'updated', 'name'] as const;
export type AppSearchSort = (typeof APP_SEARCH_SORTS)[number];

export interface AppSearchRecord {
  manifest: ExtensionManifest;
  state: AppSearchState;
  /** The version installed here, or the one the market gives this computer. */
  version: string;
  /** When the market's current version for this computer was published (`updated`); absent for an App the market does not carry. */
  publishedAt?: string;
  /** When the market first published the App (`newest`). */
  firstPublishedAt?: string;
}

export interface AppSearchRequest {
  query?: string;
  state?: readonly AppSearchState[];
  category?: readonly string[];
  /** Only Apps none of whose permissions is louder than this. */
  max_risk?: AppRisk;
  /** A file suffix (`.pdf` or `pdf`): Apps with a tab that opens it, in a chat or a session. */
  opens?: string;
  sort?: AppSearchSort;
}

/** How many records each value of a dimension has, under the query and every other dimension's filter but its own. */
export interface AppSearchFacets {
  state: Partial<Record<AppSearchState, number>>;
  category: Record<string, number>;
  risk: Partial<Record<AppRisk, number>>;
}

export const OTHER_CATEGORY = 'other';

export function appRisk(manifest: ExtensionManifest): AppRisk {
  const tiers: PermissionRisk[] = [
    ...(manifest.permissions?.capabilities ?? []).map((key) => CAPABILITY_RISK[key]),
    ...(manifest.permissions?.network ?? []).map(() => NETWORK_RISK),
  ];
  return tiers.includes('high') ? 'high' : tiers.length > 0 ? 'medium' : 'none';
}

export function appCategories(manifest: ExtensionManifest): string[] {
  return manifest.categories?.length ? [...manifest.categories] : [OTHER_CATEGORY];
}

const suffixOf = (value: string) => (value.startsWith('.') ? value : `.${value}`).toLowerCase();

export function appOpens(manifest: ExtensionManifest): string[] {
  const suffixes = manifest.contributes.tabs.flatMap((tab) => Object.values(tab.opensFiles ?? {}).flat());
  return [...new Set(suffixes.map(suffixOf))];
}

const RISK_RANK: Record<AppRisk, number> = { none: 0, medium: 1, high: 2 };

type Dimension = 'state' | 'category' | 'risk';

export function searchApps(
  records: readonly AppSearchRecord[],
  request: AppSearchRequest = {}
): { items: AppSearchRecord[]; facets: AppSearchFacets } {
  const searched = queryWords(request.query).length > 0;
  const scored = records.map((record) => ({
    record,
    score: searched ? queryScore(request.query, appSearchText(record.manifest)) : 0,
    risk: appRisk(record.manifest),
    categories: appCategories(record.manifest),
  }));
  type Scored = (typeof scored)[number];
  const opens = request.opens ? suffixOf(request.opens) : undefined;
  const passes = (entry: Scored, skip?: Dimension): boolean =>
    (!searched || entry.score > 0) &&
    (skip === 'state' || !request.state?.length || request.state.includes(entry.record.state)) &&
    (skip === 'category' || !request.category?.length || entry.categories.some((category) => request.category!.includes(category))) &&
    (skip === 'risk' || request.max_risk === undefined || RISK_RANK[entry.risk] <= RISK_RANK[request.max_risk]) &&
    (opens === undefined || appOpens(entry.record.manifest).includes(opens));

  const count = <Key extends string>(skip: Dimension, keysOf: (entry: Scored) => readonly Key[]) => {
    const counts: Partial<Record<Key, number>> = {};
    for (const entry of scored.filter((candidate) => passes(candidate, skip))) {
      for (const key of keysOf(entry)) counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  };
  const facets: AppSearchFacets = {
    state: count('state', (entry) => [entry.record.state]),
    category: count('category', (entry) => entry.categories) as Record<string, number>,
    risk: count('risk', (entry) => [entry.risk]),
  };

  const sort = request.sort ?? (searched ? 'relevance' : 'name');
  // Dated first, newest first; an App the market does not carry has no date and goes last. Every tie ends on the id,
  // so a page never shuffles between two calls.
  const byDate = (key: 'publishedAt' | 'firstPublishedAt') => (a: Scored, b: Scored) =>
    (b.record[key] ?? '').localeCompare(a.record[key] ?? '');
  const byName = (a: Scored, b: Scored) => a.record.manifest.name.localeCompare(b.record.manifest.name);
  const first: Record<AppSearchSort, (a: Scored, b: Scored) => number> = {
    relevance: (a, b) => b.score - a.score,
    newest: byDate('firstPublishedAt'),
    updated: byDate('publishedAt'),
    name: byName,
  };
  const items = scored
    .filter((entry) => passes(entry))
    .sort((a, b) => first[sort](a, b) || byName(a, b) || a.record.manifest.id.localeCompare(b.record.manifest.id))
    .map((entry) => entry.record);
  return { items, facets };
}
