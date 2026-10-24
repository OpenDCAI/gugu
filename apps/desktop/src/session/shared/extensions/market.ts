import { z } from 'zod';
import type { AppPlatform } from './app-platforms';
import {
  compareExtensionVersions,
  EXTENSION_API_VERSION,
  EXTENSION_API_VERSION_MIN_SUPPORTED,
  type ExtensionManifest,
} from './manifest';

/**
 * 市场:清单这一侧的形状与判据(#5410)。
 *
 * 与 `catalog.ts` 的分工:那份管「一个 manifest 在清单上怎么读」(分组、搜索、风险),
 * 与来源无关;这份管「扩展从云上下来这件事」——它有哪些字段、哪一版给这台机器、
 * 什么样的包允许解开。都是纯类型与纯函数,所以解压硬化、兼容挑选那几条可以在没有网络、
 * 没有 Electron 的情况下判。
 *
 * 版本这件事参照 VS Code(owner 2026-09-14):`engines` 一个宿主版本范围、市场替每台机器
 * 挑它能装的最新一版、详情页有版本历史、可装任意一版、可撤回某一版、可弃用整个扩展。
 */

/** 宿主关于自己的三个数:市场用它们回答「这一版这台机器装不装得了」。 */
export interface MarketHost {
  platform: AppPlatform;
  /** 咕咕自己的版本(可带 `-beta.3` 之类后缀;比较只看 x.y.z)。 */
  appVersion: string;
  apiVersionMin: number;
  apiVersionMax: number;
}

export function currentMarketHost(appVersion: string, platform: AppPlatform): MarketHost {
  return {
    platform,
    appVersion,
    apiVersionMin: EXTENSION_API_VERSION_MIN_SUPPORTED,
    apiVersionMax: EXTENSION_API_VERSION,
  };
}

/**
 * 为什么这台机器装不了这一版;`null` = 能装。
 *
 * 两种「装不了」对用户是两条不同的指令 ——「去更新咕咕」和「等作者更新」—— 所以分开,
 * ❌ 合并成一个「不兼容」。
 */
export type MarketCompat =
  | null
  | { reason: 'needs-newer-app'; minAppVersion: string }
  | { reason: 'needs-author-update'; apiVersion: number };

/** 市场清单上的一条:某个扩展当前给这台机器的那一版。 */
export interface CloudMarketEntry {
  manifest: ExtensionManifest;
  /** 发布时登记的版本号。与 `manifest.version` 同值,分开带是因为它是那张表的主键之一。 */
  version: string;
  /** 归档文件的 sha256(小写十六进制)。装之前用它比对下载到的字节。 */
  bundleSha256: string;
  /** 归档文件字节数。 */
  bundleBytes: number;
  apiVersion: number;
  minAppVersion: string;
  /** 这版改了什么(发布时从 CHANGELOG.md 抽的那一节,markdown)。 */
  releaseNotes: string;
  publishedAt: string;
  /** The first published version, independent of subsequent updates. */
  firstPublishedAt: string;
  /**
   * 图标的公开地址(下载站 `market/media/` 下,按内容哈希命名);没有图标就 null,卡片画首字母。
   * 清单里只带地址不带字节:图标由 `<img loading="lazy">` 滚到才取、浏览器自己缓存 ——
   * 清单请求的大小于是不随扩展数 × 图标大小增长。
   */
  iconUrl: string | null;
  /** 弃用:划掉、不推荐;可指替代扩展。null = 正常。 */
  deprecated: { note: string | null; replacedBy: string | null } | null;
  /** 这一版这台机器装不装得了。清单只放能装的最新一版,所以通常是 null;全都装不了时放最新版并说明原因。 */
  compat: MarketCompat;
  /**
   * 比给出的这一版更新、但这台机器装不了的最新版本号;没有就 null。
   * 用户看到的是「1.1.0(有 1.3.0,需要新版咕咕)」,而不是被藏起来。
   */
  newerNeedsApp: string | null;
  /** 这一版的代码在哪(索引仓里那一行的仓、提交、目录)。 */
  source: MarketCodeSource;
  /** 官方精选:近期安装数据不够时,界面侧的共享首页编排用它补齐。官方定的事,写在索引仓那条记录上,❌ 由 App 自己说。 */
  featured: boolean;
  /**
   * 首启默认组(161 10-15):新 profile 第一次启动时一页同意、一起装上的那几个。同 `featured`,官方定的事写在索引仓那条
   * 记录上 —— 客户端不点任何 App 的名字,名单改了不用发客户端。
   */
  firstRun: boolean;
}

/** 首页精选那一排几张(owner 10-19「按建议」)。看多近、多久减半写在库函数 `chat.market_install_ranking` 里(14 天、7 天)。 */
export const FEATURED_COUNT = 3;

/** 下载站上 `market/` 根里的一个文件:相对路径,❌ `..`、❌ 绝对地址 —— 只能落在 market 根下面。 */
const marketPath = z.string().regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/);

/**
 * 下载站上的 `market/index.json`:市场的全部内容,一个文件(App 市场 10-08,owner:市场不放数据库)。
 *
 * 真相在 GitHub 索引仓 shuxueshuxue/gugu-apps(每个 App 一个 json:哪一版、哪个仓 @ 提交 @ 目录、sha256、
 * 撤回 / 停维 / 下架)。那边的 CI 照提交重新打包、核过 sha256,合并后把包、README、图标和这份目录同步到下载站;
 * 下架的 App 不在这份目录里。客户端只读下载站,❌ 直连 GitHub。
 */
export const marketIndexSchema = z.object({
  apps: z.array(
    z.object({
      id: z.string(),
      /** 官方精选(#7059)。可选:旧的目录没有这一键,读作 false。 */
      featured: z.boolean().optional(),
      /** 首启默认组(161 10-15)。可选:没有这一键读作 false。 */
      firstRun: z.boolean().optional(),
      deprecated: z.object({ note: z.string().nullable(), replacedBy: z.string().nullable() }).nullable(),
      versions: z.array(
        z.object({
          version: z.string(),
          /** 包里的 manifest.json 原样;形状由客户端按自己的协议号判,所以这里不定型。 */
          manifest: z.unknown(),
          apiVersion: z.number().int(),
          minAppVersion: z.string(),
          releaseNotes: z.string(),
          publishedAt: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          bytes: z.number().int().positive(),
          bundle: marketPath,
          icon: marketPath.nullable(),
          readme: marketPath.nullable(),
          source: z.object({ repo: z.string(), path: z.string(), commit: z.string() }),
          yanked: z.object({ reason: z.string() }).nullable(),
        })
      ),
    })
  ),
});
export type MarketIndex = z.infer<typeof marketIndexSchema>;
export type MarketIndexApp = MarketIndex['apps'][number];
export type MarketIndexVersion = MarketIndexApp['versions'][number];

/** 版本历史里的一行(详情面板打开时按扩展取)。 */
export interface MarketVersionHistoryEntry {
  version: string;
  publishedAt: string;
  releaseNotes: string;
  apiVersion: number;
  minAppVersion: string;
  yanked: { reason: string } | null;
  compat: MarketCompat;
  /** A version may satisfy the host API while not declaring support for this device. */
  platformRefusal?: string | null;
}

/** 启动时那一趟检查的结果:装着的这些扩展,各自有什么要告诉用户的。 */
export interface MarketUpdatesSummary {
  checkedAt: string;
  /** 有更新的:id → 这台机器能装的更新版本。 */
  updates: Record<string, { version: string; releaseNotes: string }>;
  /** 装着的那一版已被撤回:id → 原因 + 可换到哪一版(没有就 null)。 */
  yanked: Record<string, { reason: string; installable: string | null }>;
  /** 扩展已弃用:id → 说明 + 替代品。 */
  deprecated: Record<string, { note: string | null; replacedBy: string | null }>;
  /**
   * 从市场装的、这份目录里却没有它(索引仓标了 `unlisted`):不会再有更新(VS Code「no longer available on the Marketplace」,
   * owner 10-19)。照常能用,❌ 卸载。可选:App 页看的另一台机器(#6264)是更早的咕咕时,它的回答里没有这一项。
   */
  gone?: string[];
}

/**
 * 一张卡片要装的那一版。装之前先得把它变成一个**目录**——因为安装路径只认目录
 * (inspect → 点头 → install):这一版在云上,下载、比对指纹、解包之后才是目录。
 * 市场只有下载站这一个来源(App 市场方案 10-07,owner「按你的来」:离线备份删了,连不上就照实说连不上)。
 */
export interface MarketSourceRef {
  extensionId: string;
  version: string;
}

/**
 * 这一版的代码在哪:索引仓里那一行写的仓、提交、目录(App 市场方案:App 的家在它自己的仓库里,
 * 市场只收录「仓 @ 提交 @ 目录」打出来的那一份字节;索引仓的 CI 照它重打、核过 `bundleSha256`)。
 */
export interface MarketCodeSource {
  /** GitHub 上的 owner/name。 */
  repo: string;
  /** 相对仓根的目录;`.` 是仓根本身。 */
  path: string;
  commit: string;
}

/** 来源的人话:`owner/name @ 提交前 7 位`,目录不是仓根时带上目录。 */
export function marketSourceLabel(source: MarketCodeSource): string {
  const at = `${source.repo} @ ${source.commit.slice(0, 7)}`;
  return source.path === '.' ? at : `${at} · ${source.path}`;
}

/** 来源在 GitHub 上那一页:那个提交里的那个目录。 */
export function marketSourceUrl(source: MarketCodeSource): string {
  const base = `https://github.com/${source.repo}/tree/${source.commit}`;
  return source.path === '.' ? base : `${base}/${source.path.split('/').map(encodeURIComponent).join('/')}`;
}

/** 下载进度,主进程推给界面。`total` 是清单上登记的字节数,所以从第一包起就有百分比。 */
export interface MarketDownloadProgress {
  extensionId: string;
  version: string;
  received: number;
  total: number;
}

// ---------------------------------------------------------------------------
// 兼容与挑选
// ---------------------------------------------------------------------------

/** `0.2.40-beta.3+build` → `0.2.40`;不像 x.y.z 的返回 null。 */
export function semverCore(version: string): string | null {
  const match = /^v?(\d+\.\d+\.\d+)/.exec(version.trim());
  return match ? match[1] : null;
}

/** 这台咕咕(appVersion)满不满足这一版的最低要求。版本号读不出 x.y.z 时按不满足算。 */
export function appSatisfies(minAppVersion: string, appVersion: string): boolean {
  const app = semverCore(appVersion);
  const min = semverCore(minAppVersion);
  if (!app || !min) return false;
  return compareExtensionVersions(app, min) >= 0;
}

/** 一行版本对这台机器的兼容结论。先看协议号(硬门),再看最低咕咕版本。 */
export function compatOf(
  row: { apiVersion: number; minAppVersion: string },
  host: MarketHost
): MarketCompat {
  if (row.apiVersion > host.apiVersionMax) {
    return { reason: 'needs-newer-app', minAppVersion: row.minAppVersion };
  }
  if (row.apiVersion < host.apiVersionMin) {
    return { reason: 'needs-author-update', apiVersion: row.apiVersion };
  }
  if (!appSatisfies(row.minAppVersion, host.appVersion)) {
    return { reason: 'needs-newer-app', minAppVersion: row.minAppVersion };
  }
  return null;
}

/**
 * 从一个扩展的版本列表里挑这台机器该看到的那一版(VS Code 市场替客户端挑版本的那件事)。
 *
 * 输入不要求有序;撤回的一律不算。结果:
 * - `chosen`:最新的一版能装的;一版都不能装时是最新的那版(附 compat 说明),全撤回了才是 null。
 * - `newerNeedsApp`:比 chosen 更新、但装不了的最新版本号 —— 让用户知道「有更新的,只是要新版咕咕」。
 */
export function pickForHost<T extends { version: string; apiVersion: number; minAppVersion: string; yanked?: unknown }>(
  rows: readonly T[],
  host: MarketHost
): { chosen: (T & { compat: MarketCompat }) | null; newerNeedsApp: string | null } {
  const live = rows
    .filter((row) => !row.yanked)
    .slice()
    .sort((a, b) => compareExtensionVersions(b.version, a.version));
  if (live.length === 0) return { chosen: null, newerNeedsApp: null };
  const installable = live.find((row) => compatOf(row, host) === null);
  if (!installable) {
    const newest = live[0]!;
    return { chosen: { ...newest, compat: compatOf(newest, host) }, newerNeedsApp: null };
  }
  const newest = live[0]!;
  return {
    chosen: { ...installable, compat: null },
    newerNeedsApp: newest.version === installable.version ? null : newest.version,
  };
}

/**
 * 比对装着的和清单给的:要不要提示「有新版」。
 * 清单给的那一版已经是「这台机器能装的最新一版」,所以只比大小;装着比清单还新(本地装的开发版)不提示。
 */
export function isUpdateFor(installedVersion: string, offeredVersion: string): boolean {
  return compareExtensionVersions(offeredVersion, installedVersion) > 0;
}

// ---------------------------------------------------------------------------
// 解包硬化
// ---------------------------------------------------------------------------

/**
 * 归档里一条路径能不能解开。返回拒绝的理由,`null` 表示放行。
 *
 * 本地安装器是**刻意保留符号链接**的(`cpSync` 带 `verbatimSymlinks`),因为用户自己挑的
 * 文件夹里那些链接是他自己的东西;而从云上下来的归档没有任何人看过,里面的路径是攻击面:
 * 一条 `../../../.ssh/authorized_keys` 就把「解包」变成了「往任意位置写文件」。
 * ⇒ 解包只接受**老实的相对路径**,其余一律拒绝整个包(❌ 不是跳过这一条:
 * 一个包里有这种条目,它整体就不可信,装它剩下的部分等于把判断权让给了作者)。
 */
export function bundleEntryRejection(entryName: string): string | null {
  if (entryName === '') return 'empty path';
  // 反斜杠:zip 规范要求用 '/',写反斜杠的条目在 Windows 上会被当成分隔符、在别处不会,
  // 同一个包在两个平台解出不同的形状。
  if (entryName.includes('\\')) return `backslash in path: ${entryName}`;
  if (entryName.startsWith('/')) return `absolute path: ${entryName}`;
  if (/^[a-zA-Z]:/.test(entryName)) return `absolute path: ${entryName}`;
  if (/[ -]/.test(entryName)) return `control character in path: ${entryName}`;
  const segments = entryName.split('/');
  if (segments.includes('..')) return `path escapes the bundle: ${entryName}`;
  // `/_gugu/` on every App origin is the platform runtime (app-runtime-protocol.ts): a bundle's
  // own copy would never be served, and its author would chase why.
  if (segments[0]?.toLowerCase() === '_gugu') return `reserved path (the platform runtime lives there): ${entryName}`;
  return null;
}

/** 解包的上限。包是几百 KB 的 HTML/JS;这两个数只是不让一个畸形的包把磁盘吃光。 */
export const MAX_BUNDLE_ENTRIES = 2000;
export const MAX_BUNDLE_UNPACKED_BYTES = 64 * 1024 * 1024;
// 打包时跳过的东西:它们不是扩展的一部分,而且会让同一份源码打出不同的字节。
export const BUNDLE_SKIP_NAMES: ReadonlySet<string> = new Set(['.DS_Store', '.git', 'node_modules', '.gugu-market.json']);

/**
 * 下载:这么久一个新字节都没来才算失败(等回答的那段也算),❌ 不让按钮永远转「读取中」。只要还在往下走就让它下完 ——
 * ❌ 给整份一个上限(161 10-16:整份 30 s 时,弱网 < ~36 kB/s 咕咕办公永远下不完,首启只会一直「下次再试」)。
 */
export const BUNDLE_STALL_TIMEOUT_MS = 30_000;
/**
 * 清单一页几条。两列卡、六行,不到一屏 —— 翻页必须**看得见**(owner 2026-09-14:一页 24 张加滚到底自动接,
 * 在他眼里就是「一次性全加载」)。下一页由用户点「加载更多」才取,❌ 滚到底自动接。
 * 按 name、id 排好序再切页(同一份目录),所以翻页之间不会重复或漏掉。
 */
export const MARKET_PAGE_SIZE = 12;

// ---------------------------------------------------------------------------
// 市场页拿到的一条
// ---------------------------------------------------------------------------

/** 市场那条记录里除 manifest 之外的部分(manifest 单独放在外层)。 */
export type CloudMarketEntryMeta = Omit<CloudMarketEntry, 'manifest'>;

/**
 * 市场页画的一条:manifest 画卡片,ref 说装的时候装哪一版,cloud 是清单上那一版的其余
 * (版本、兼容、弃用、图标、更新说明、代码在哪)。
 */
export interface MarketListItem {
  manifest: ExtensionManifest;
  ref: MarketSourceRef;
  cloud: CloudMarketEntryMeta;
}
