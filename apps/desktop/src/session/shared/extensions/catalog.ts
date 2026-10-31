import {
  compareExtensionVersions,
  type ExtensionCapability,
  type ExtensionManifest,
} from './manifest';
import { queryScore, queryWords } from './query-score';

/**
 * The shelf side of extensions — what the market tab and the installed list
 * need to know about a bundle beyond「装得上吗」. Pure functions over manifests
 * so the same grouping, search and risk reading can be judged without a DOM.
 * Refs #5265.
 */

/**
 * How loudly a permission should be drawn.
 *
 * Two tiers, not three: every capability an extension can declare either stays
 * with what the App itself started (medium) or reaches past it — every chat's
 * files, messages in the person's name, whole conversations, driving agents,
 * leaving the machine (high). A "low" tier would only ever be empty, and an empty tier is a
 * label that tells the reader nothing.
 */
export type PermissionRisk = 'high' | 'medium';

export const CAPABILITY_RISK = {
  // Any chat the person is in, and this computer's sessions — wherever the page is.
  'files:read': 'high',
  // Beyond this computer: the sessions' files on all of the person's machines, read only.
  'files:read:all-machines': 'high',
  'files:write': 'high',
  // A whisper in the person's name, in any chat they are in.
  'chat:relay': 'high',
  // What was said in any chat the person is in.
  'chat:read': 'high',
  'agents:read': 'medium',
  // Every `:all` widens past the agents the App started — that widening is the whole point of
  // reading it as high, even for the ability that is medium in its narrow form.
  'agents:read:all': 'high',
  // Beyond this computer: every agent on all of the person's machines.
  'agents:read:all-machines': 'high',
  'agents:history': 'high',
  'agents:history:all': 'high',
  'agents:control': 'high',
  'agents:control:all': 'high',
  'agents:control:all-machines': 'high',
  // Runs a program of the extension's choosing on this machine, with the person's rights.
  'agents:tools': 'high',
  // A banner under the extension's own name: noise at worst, bounded per minute.
  'notifications': 'medium',
} as const satisfies Record<ExtensionCapability, PermissionRisk>;

/** Leaving the machine is always the loud tier, whichever host it names. */
export const NETWORK_RISK: PermissionRisk = 'high';

export type DeclaredPermission =
  | { kind: 'capability'; key: ExtensionCapability; risk: PermissionRisk }
  | { kind: 'network'; key: string; host: string; risk: PermissionRisk };

/**
 * Everything a manifest asks for, loud ones first. Within a tier the manifest's
 * own order is kept — the author chose it, and a chip row that reorders on its
 * own is harder to match against the consent dialog.
 */
export function declaredPermissions(manifest: ExtensionManifest): DeclaredPermission[] {
  const capabilities = (manifest.permissions?.capabilities ?? []).map(
    (key): DeclaredPermission => ({ kind: 'capability', key, risk: CAPABILITY_RISK[key] })
  );
  const hosts = (manifest.permissions?.network ?? []).map(
    (host): DeclaredPermission => ({ kind: 'network', key: host, host, risk: NETWORK_RISK })
  );
  const all = [...capabilities, ...hosts];
  const high = all.filter((permission) => permission.risk === 'high');
  const medium = all.filter((permission) => permission.risk === 'medium');
  return [...high, ...medium];
}

/**
 * 产品页「权限」分两栏(#7059,照 Slack 的「能看 / 能做」):读到什么归「它能看」,替人动手、跑程序、发通知、
 * 往外连网归「它能做」。每一项照样能单独收回。
 */
export function permissionSide(permission: DeclaredPermission): 'see' | 'do' {
  if (permission.kind === 'network') return 'do';
  return permission.key.startsWith('files:read') || permission.key.startsWith('agents:read') || permission.key.startsWith('agents:history') || permission.key === 'chat:read'
    ? 'see'
    : 'do';
}

/**
 * Where an installed extension sits on the installed tab (#7059,原型「已安装按『有更新 / 已启用 / 未启用』分组」).
 *
 * `attention` comes first and only exists when something needs a decision — a directory on disk that cannot be read,
 * a version withdrawn, an App no longer maintained; the prototype had none of those, the real list does. A withdrawn
 * permission is not a group of its own: the App still runs, and its row says how many were taken back.
 */
export type InstalledGroup = 'attention' | 'update' | 'active' | 'disabled';

export const INSTALLED_GROUP_ORDER: readonly InstalledGroup[] = ['attention', 'update', 'active', 'disabled'];

/**
 * 云端那口(`MarketUpdatesSummary`)对这一件装着的扩展要说的话,只挑一样(#5410)。
 * `yanked`/`deprecated` 比「有新版」更急 —— 前两者是「这一版不该再信」,后者只是
 * 「有个更新的」,所以同时命中时前者赢(见 `installedGroupOf`)。
 */
export type InstalledUpdateFlag = 'update' | 'yanked' | 'deprecated' | null;

export function installedGroupOf(enabled = true, flag: InstalledUpdateFlag = null): InstalledGroup {
  // 撤回/弃用比其余一切都急 —— 即使这份扩展当前是关着的,「这一版不该再信」
  // 这件事用户也该看得见,不因为它没在跑就被埋进「未启用」那组里。
  if (flag === 'yanked' || flag === 'deprecated') return 'attention';
  // Off outranks a plain "there's an update": a switched-off extension is not running, so whether a newer version
  // exists is moot until it is switched back on.
  if (!enabled) return 'disabled';
  if (flag === 'update') return 'update';
  return 'active';
}

/**
 * Search over the words a person or an agent would actually type: the name, the id, the subtitle, the instructions
 * (群文件夹's「markdown」「JSON」are there), the author and the categories. Not the permission keys — nobody looks for
 * an App by typing `files:read`. The name and subtitle in each language of `localized` count too.
 * The same text an agent's app_search reads (app-search.ts); scored word by word (query-score.ts).
 */
export function appSearchText(manifest: ExtensionManifest): string {
  return [
    manifest.name,
    manifest.id,
    manifest.subtitle ?? '',
    manifest.contributes.instructions ?? '',
    ...Object.values(manifest.localized ?? {}).flatMap((text) => [text.name ?? '', text.subtitle ?? '']),
    manifest.author ?? '',
    ...(manifest.categories ?? []),
    ...manifest.contributes.tabs.map((tab) => tab.title),
  ].join('\n');
}

export function matchesExtensionQuery(manifest: ExtensionManifest, query: string): boolean {
  return queryWords(query).length === 0 || queryScore(query, appSearchText(manifest)) > 0;
}

/**
 * The one character a card draws in place of an icon.
 *
 * The first grapheme, not the first UTF-16 unit: a name that starts with an
 * emoji or a CJK character must not be cut in half. Falls back to the first
 * code point where `Intl.Segmenter` is unavailable.
 */
export function extensionMonogram(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    const first = segmenter.segment(trimmed)[Symbol.iterator]().next().value;
    if (first) return first.segment.toUpperCase();
  }
  return [...trimmed][0]!.toUpperCase();
}

export type ShelfRelation =
  | 'not-installed'
  /** The shelf carries exactly the installed version. */
  | 'installed-same'
  /** The shelf carries something newer than what is installed. */
  | 'installed-older'
  /** What is installed is newer than the shelf — a local edit or a dev build. */
  | 'installed-newer';

export function shelfRelation(
  shelf: ExtensionManifest,
  installed: ExtensionManifest | undefined
): ShelfRelation {
  if (!installed) return 'not-installed';
  const order = compareExtensionVersions(shelf.version, installed.version);
  if (order === 0) return 'installed-same';
  return order > 0 ? 'installed-older' : 'installed-newer';
}

/** `tag` and `other` name the same language (`zh-CN` and `zh`): what the market's language choice and `localized` match by. */
const sameLanguage = (tag: string, other: string) => tag.split('-')[0] === other.split('-')[0];

/**
 * 卡片/产品页画的名字、副标题、示例句,用 `locale` 那种语言:是 `defaultLocale` 的语言就是主字段,`localized` 写了这种语言就用它
 * (先试完整标签,再试语言前缀,`zh-CN` → `zh`),都没有就是主字段。没写副标题就是空的,❌ 回落到别的字段或别的语言。
 */
export function localizedManifestText(
  manifest: Pick<ExtensionManifest, 'name' | 'defaultLocale' | 'localized'> & Partial<Pick<ExtensionManifest, 'examples' | 'subtitle'>>,
  locale: string
): { name: string; subtitle: string; examples: readonly string[] } {
  const table = manifest.localized ?? {};
  const entry = sameLanguage(locale, manifest.defaultLocale)
    ? undefined
    : (table[locale] ?? Object.entries(table).find(([tag]) => sameLanguage(tag, locale))?.[1]);
  return {
    name: entry?.name ?? manifest.name,
    subtitle: entry ? (entry.subtitle ?? '') : (manifest.subtitle ?? ''),
    examples: entry?.examples ?? manifest.examples ?? [],
  };
}

/**
 * 产品页能换成哪几种语言:`defaultLocale` 和 `localized` 的每一个(同一语言只取一个),界面语言那一格打头,没有就是 `defaultLocale`。
 * 每一格的 `locale` 原样交给 `localizedManifestText`,也是市场 `about` 的键。只有一格 = 没得换。
 */
export function manifestLanguages(manifest: Pick<ExtensionManifest, 'defaultLocale' | 'localized'>, locale: string): { locale: string; language: string }[] {
  const written = [manifest.defaultLocale, ...Object.keys(manifest.localized ?? {})].filter(
    (tag, index, tags) => tags.findIndex((other) => sameLanguage(other, tag)) === index
  );
  const own = written.find((tag) => sameLanguage(tag, locale)) ?? manifest.defaultLocale;
  return [own, ...written.filter((tag) => tag !== own)].map((tag) => ({ locale: tag, language: tag.split('-')[0]! }));
}

/**
 * 市场分区(#7059,原型「按研究 / 效率 / 开发分区」):官方的一张类别表,顺序就是页上从上到下的顺序。
 * manifest 的 `categories` 是自由 slug;表里没有的(或没写)归「其他」,排在最后 —— 市场只由官方发布,
 * 上架时把类别对上表是官方的事,❌ 照作者写的 slug 现开一个区。
 */
export const MARKET_CATEGORIES = ['research', 'productivity', 'developer'] as const;
export type MarketCategory = (typeof MARKET_CATEGORIES)[number] | 'other';

/** 一个 App 落在哪一区:它写的类别里第一个在表里的;都不在就「其他」。 */
export function marketCategoryOf(manifest: Pick<ExtensionManifest, 'categories'>): MarketCategory {
  const known = (manifest.categories ?? []).find((slug): slug is (typeof MARKET_CATEGORIES)[number] =>
    (MARKET_CATEGORIES as readonly string[]).includes(slug)
  );
  return known ?? 'other';
}

/** 分区在页上的次序:表里的照表,「其他」最后。 */
export function marketCategoryRank(category: MarketCategory): number {
  const index = (MARKET_CATEGORIES as readonly string[]).indexOf(category);
  return index === -1 ? MARKET_CATEGORIES.length : index;
}
