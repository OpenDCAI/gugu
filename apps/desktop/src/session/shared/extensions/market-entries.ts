import { z } from 'zod';
import { compareExtensionVersions, safeParseExtensionManifest, type ExtensionManifest } from './manifest';
import { forkBehind } from './variants';
import { appPlatformDeclarationProblems } from './app-platforms';
import {
  compatOf,
  isUpdateFor,
  pickForHost,
  type CloudMarketEntry,
  type MarketCompat,
  type MarketHost,
  type MarketIndex,
  type MarketIndexApp,
  type MarketIndexVersion,
  type MarketUpdatesSummary,
  type MarketVersionHistoryEntry,
} from './market';

/**
 * 市场目录 → 这台机器能看到的那几条,和「装着的有什么要告诉人的」。纯函数:桌面主进程(market-catalog.ts,目录从下载站取)
 * 和手机(phoneMarket.ts,目录经壳子的原生读取器取)读同一份目录,答案也是同一个 —— ❌ 两边各写一份挑版本的规矩。
 */

/** 一条目录记录没能列出来的原因(读不出来的行报告,不跳过)。 */
export interface InvalidMarketRow {
  extensionId: string;
  reason: string;
}

/** 目录里的 App → 卡片:替这台机器挑版本、读 manifest;读不出来的行报告而不是跳过。全撤回了的,清单上没有这一行。 */
export function marketEntriesFrom(
  apps: readonly MarketIndexApp[],
  host: MarketHost,
  urlOf: (relativePath: string) => string
): { extensions: CloudMarketEntry[]; invalid: InvalidMarketRow[] } {
  const extensions: CloudMarketEntry[] = [];
  const invalid: InvalidMarketRow[] = [];
  for (const app of apps) {
    const picked = pickForHost(app.versions.filter((version) => appPlatformDeclarationProblems(version.manifest, host.platform).length === 0), host);
    if (!picked.chosen) {
      const live = app.versions.filter((version) => !version.yanked);
      if (live.length && live.every((version) => appPlatformDeclarationProblems(version.manifest).length > 0)) {
        invalid.push({ extensionId: app.id, reason: appPlatformDeclarationProblems(live[0]!.manifest).join('; ') });
      }
      continue;
    }
    const entry = entryFrom(app, picked.chosen, picked.newerNeedsApp, urlOf);
    if ('reason' in entry) invalid.push(entry);
    else extensions.push(entry);
  }
  return { extensions, invalid };
}

function entryFrom(
  app: MarketIndexApp,
  version: MarketIndexVersion & { compat: MarketCompat },
  newerNeedsApp: string | null,
  urlOf: (relativePath: string) => string
): CloudMarketEntry | InvalidMarketRow {
  const parsed = safeParseExtensionManifest(version.manifest);
  let manifest: ExtensionManifest;
  if (parsed.ok) {
    if (parsed.manifest.id !== app.id || parsed.manifest.version !== version.version) {
      // 目录里的 id / 版本与 manifest 自己说的必须是同一件事;对不上说明发布那一侧把两者写岔了,
      // 而用户看到的版本号会与他装到的不是同一版。
      return {
        extensionId: app.id,
        reason: `manifest says ${parsed.manifest.id}@${parsed.manifest.version}, index says ${app.id}@${version.version}`,
      };
    }
    manifest = parsed.manifest;
  } else if (version.compat !== null) {
    // 协议号超出这台宿主的,manifest 本来就解析不过 —— 那不是「存坏了」,是兼容问题,compat 已经说清楚了;
    // 卡片仍要画出来(名字、描述、「需要更新咕咕」),所以只取几个不会变的字段,权限那块留空 —— 反正装不了。
    manifest = placeholderManifest(app.id, version);
  } else {
    return { extensionId: app.id, reason: parsed.issues.join('; ') };
  }
  return {
    manifest,
    version: version.version,
    bundleSha256: version.sha256,
    bundleBytes: version.bytes,
    apiVersion: version.apiVersion,
    minAppVersion: version.minAppVersion,
    releaseNotes: version.releaseNotes,
    publishedAt: version.publishedAt,
    firstPublishedAt: app.versions.map((entry) => entry.publishedAt).sort()[0]!,
    iconUrl: version.icon ? urlOf(version.icon) : null,
    deprecated: app.deprecated,
    compat: version.compat,
    newerNeedsApp,
    source: version.source,
    featured: app.featured === true,
    firstRun: app.firstRun === true,
  };
}

/**
 * 这台宿主读不懂的 manifest(协议号更新,或早于最低支持的那一版):只取名字、副标题、作者画卡片。
 * 它的语言 manifest 没说(早于 `defaultLocale`)就写 `und`(BCP 47 的「未定」),❌ 冠上界面语言。
 */
function placeholderManifest(id: string, version: MarketIndexVersion): ExtensionManifest {
  const raw = (version.manifest ?? {}) as Record<string, unknown>;
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : id;
  return {
    id,
    name,
    version: version.version,
    apiVersion: version.apiVersion,
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: name }] },
    defaultLocale: typeof raw.defaultLocale === 'string' ? raw.defaultLocale : 'und',
    ...(typeof raw.subtitle === 'string' ? { subtitle: raw.subtitle } : {}),
    ...(typeof raw.author === 'string' ? { author: raw.author } : {}),
    ...(Array.isArray(raw.platforms) ? { platforms: raw.platforms as NonNullable<ExtensionManifest['platforms']> } : {}),
  };
}

/**
 * 装着的这些 App,各自有什么要告诉人的:有新版 / 装的这版被撤回了 / 已弃用。只读、只比对;❌ 不下载、❌ 不安装。
 * `index` 要是现在的那份(调用方现取)。
 */
export function marketUpdatesFrom(
  index: MarketIndex,
  host: MarketHost,
  installed: readonly { id: string; version: string; fromMarket?: boolean; forkBase?: string }[],
  checkedAt: string
): MarketUpdatesSummary {
  const summary: MarketUpdatesSummary & { gone: string[] } = { checkedAt, updates: {}, yanked: {}, deprecated: {}, gone: [] };
  const ids = new Set(installed.map((entry) => entry.id));
  const apps = index.apps.filter((app) => ids.has(app.id));
  const { extensions } = marketEntriesFrom(apps, host, (relativePath) => relativePath);
  const offeredById = new Map(extensions.map((entry) => [entry.manifest.id, entry]));
  for (const { id, version, fromMarket, forkBase } of installed) {
    const app = apps.find((entry) => entry.id === id);
    if (!app) {
      // Installed from the market and no longer in it; one from a folder or a chat was never in it.
      if (fromMarket) summary.gone.push(id);
      continue;
    }
    if (app.deprecated) summary.deprecated[id] = app.deprecated;
    if (forkBase !== undefined) {
      const behind = forkBehind(forkBase, app.versions);
      if (behind) (summary.forkBehind ??= {})[id] = behind;
      continue;
    }
    const offered = offeredById.get(id);
    const yanked = app.versions.find((entry) => entry.version === version)?.yanked;
    if (yanked) {
      summary.yanked[id] = {
        reason: yanked.reason,
        installable: offered && offered.compat === null ? offered.version : null,
      };
      continue;
    }
    if (offered && offered.compat === null && isUpdateFor(version, offered.version)) {
      summary.updates[id] = { version: offered.version, releaseNotes: offered.releaseNotes };
    }
  }
  return summary;
}

/** 一个 App 的全部版本,最新的在前;每一版带这台机器装不装得了、撤回没有(产品页的版本历史、手机的「其他版本」)。 */
export function marketHistoryFrom(app: MarketIndexApp | null, host: MarketHost): MarketVersionHistoryEntry[] {
  return (app?.versions ?? [])
    .slice()
    .sort((a, b) => compareExtensionVersions(b.version, a.version))
    .map((version) => ({
      version: version.version,
      publishedAt: version.publishedAt,
      releaseNotes: version.releaseNotes,
      apiVersion: version.apiVersion,
      minAppVersion: version.minAppVersion,
      yanked: version.yanked,
      compat: compatOf(version, host),
      platformRefusal: appPlatformDeclarationProblems(version.manifest, host.platform).join('; ') || null,
    }));
}

/**
 * 自动更新换到哪一版(owner 10-19「app 版本管理 参考 vscode extension 版本管理」「1 可以」):`installed` 是调用方挑好的那几个 ——
 * 市场装的、启用着、自动更新开着(照 VS Code `shouldAutoUpdateExtension`:钉住的、单独关了的、停用的都不更新,
 * https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts#L2337-L2372 )。
 * 换到的是市场给这台机器的那一版,比装着的新才换;装着的这一版撤回了,目录给了一版能换的,也照这条(撤回的那一行不进 `updates`)。
 * ❌ 往回换:撤回了、能换的那版却更旧,照旧只告知(撤回是告知,不是远程禁用)。要不要问人,由安装那一步判。
 */
export function autoUpdatesFrom(
  summary: MarketUpdatesSummary,
  installed: readonly { id: string; version: string }[]
): { id: string; from: string; version: string }[] {
  return installed.flatMap(({ id, version }) => {
    const offered = summary.updates[id]?.version ?? summary.yanked[id]?.installable ?? null;
    return offered && isUpdateFor(version, offered) ? [{ id, from: version, version: offered }] : [];
  });
}

/**
 * 装上的这一版比市场给这台机器的那一版旧:人自己挑的旧版,这个 App 从此不自动更新(VS Code 装指定版本就钉住 `pinned`,
 * 自动更新跳过它,https://github.com/microsoft/vscode/blob/af18ca5130bd7164867b2784b3aba68b4de38116/src/vs/platform/extensionManagement/node/extensionManagementService.ts#L1090 )。
 * 按「更新」装上市场给的那一版、第一次装最新的,都不算。
 */
export function pinsAutoUpdate(installedVersion: string, offeredVersion: string | null): boolean {
  return offeredVersion !== null && isUpdateFor(installedVersion, offeredVersion);
}

/**
 * 一版的产品页内容(App 模型 v2):关于(每种语言一份,键是 manifest 的 `defaultLocale` 和 `localized` 的标签)和截图地址。
 * 发布时从源码的 `store/` 读出、核过(app-listing.ts),写进下载站上这一版的 meta(索引仓 sync.mjs 写 `meta/<id>/<版本>.json`);
 * 不进安装包,所以本机装的 App 没有它。这一版的「新功能」不在这里:它是目录里每一版的 `releaseNotes`。
 */
export interface MarketListing {
  about: Record<string, string>;
  /** 下载站上的地址,按文件名排好。 */
  screenshots: string[];
}

/** 下载站上一版的 meta 在哪(sync.mjs 的 `metaKey`)。 */
export const marketMetaPath = (extensionId: string, version: string) => `meta/${extensionId}/${version}.json`;

const marketListingSchema = z.object({
  about: z.record(z.string(), z.string().min(1)),
  screenshots: z.array(z.string().regex(/^media\/[\w.\-/]+$/)).min(1),
});

/** meta 的原文 → 产品页内容。早于产品页内容的版本(meta 里没有)当场说清楚,❌ 当成空的。 */
export function marketListingFrom(metaText: string, extensionId: string, version: string, urlOf: (relativePath: string) => string): MarketListing {
  const parsed = marketListingSchema.safeParse(JSON.parse(metaText));
  if (!parsed.success) throw new Error(`${extensionId}@${version} has no store listing in the market (published before store/): ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`);
  return { about: parsed.data.about, screenshots: parsed.data.screenshots.map(urlOf) };
}
