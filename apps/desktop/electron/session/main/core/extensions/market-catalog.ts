import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import JSZip from 'jszip';
import type {
  CloudMarketEntry,
  MarketCodeSource,
  MarketCompat,
  MarketHost,
  MarketIndexApp,
  MarketUpdatesSummary,
  MarketVersionHistoryEntry,
} from '@shared/extensions/market';
import { compatOf, featuredOf, MARKET_PAGE_SIZE, marketHome, type MarketHomeSection } from '@shared/extensions/market';
import { safeParseExtensionManifest } from '@shared/extensions/manifest';
import { MARKET_CATEGORIES, marketCategoryOf, type MarketCategory } from '@shared/extensions/catalog';
import { appSurfaces, searchApps, type AppSearchRecord, type AppSearchSort, type AppSurface } from '@shared/extensions/app-search';
import { queryWords } from '@shared/extensions/query-score';
import { archiveRefusal, unpackedTooMuch } from '@shared/extensions/bundle-checks';
import { marketEntriesFrom, marketHistoryFrom, marketUpdatesFrom, type InvalidMarketRow } from '@shared/extensions/market-entries';
import {
  marketSnapshotSource,
  type MarketRefreshed,
  type MarketSnapshot,
  type MarketSnapshotSource,
  type MarketSnapshotStore,
} from '@shared/extensions/market-snapshot';
import { EXTENSION_MANIFEST_FILENAME } from './extensions-service';

/**
 * App 市场(#5410;10-08 起数据源是下载站上的一份 `market/index.json`,见 `marketIndexSchema`)。
 *
 * **只换来源,不换安装路径**:这个类做的全部事情是把「市场上那一版」变成机器上的一个目录,
 * 然后交给已有的 `inspect → 点头 → install`。它不安装、不改权限、不碰已装的扩展 ——
 * 那条路已经审过一遍,市场不该成为代码落到机器上的第二条通道。
 *
 * 版本这件事(owner 2026-09-14,参照 VS Code):替这台机器挑它能装的最新一版
 * (`engines` 下界 + 协议号),详情页有版本历史、可装任意一版,撤回的一版不可装,
 * 弃用的扩展划掉。启动时那一趟「有没有新版 / 我装的这版被撤了没」也从这里出。
 *
 * 市场只有这一个来源(App 市场方案 10-07):连不上就照实说连不上,❌ 退回任何本地清单或 GitHub。
 *
 * 整个市场就是一份目录:分页、搜索、版本历史、撤回都是对同一份目录的运算,❌ 不为它们各开一种请求。
 * 不 import electron,下载站、落地目录、宿主版本都注入 —— 于是整条下载/校验/解包/挑版本可以对着临时目录判。
 */

export interface BundleDownloadOptions {
  /** 目录上登记的字节数:收到的超过它就当场断,❌ 不等整个收完再比。 */
  expectedBytes: number;
  onProgress?: (received: number) => void;
}

/** 下载站的 `market/` 根。路径都是目录里写的相对路径。 */
export interface MarketBackend {
  /** 一个文本文件(`index.json`、README)。连不上、不是 2xx 都**抛**,❌ 回空串冒充「没有」。 */
  readText(relativePath: string): Promise<string>;
  /** 一个包的字节,边收边报进度、超过登记大小就断。 */
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array>;
  /** 一个文件的公开地址(图标交给 `<img>` 自己取、自己缓存)。 */
  urlOf(relativePath: string): string;
}

export type { InvalidMarketRow };

export interface CloudMarketListing {
  extensions: CloudMarketEntry[];
  invalid: InvalidMarketRow[];
  /** 满足条件的总条数(不只这一页)。 */
  total: number;
  /** 这一页是第几页(从 0 起)。 */
  page: number;
  /** 后面还有没有。 */
  hasMore: boolean;
  /** 首页精选那一排(`featuredOf`):只随第一页、不带搜索词时给,别的时候是空的;它们在下面照样各有一行。 */
  featured: CloudMarketEntry[];
  /** 首页精选下面那几排(`marketHome`):每一排一个推荐理由;同 `featured`,只随不带搜索词的第一页。 */
  home: { kind: MarketHomeSection; entries: CloudMarketEntry[] }[];
  /**
   * 「类别」页那几张卡:每一类几个、前三个的图标(照搜索词和「用在哪」筛过,❌ 照类别筛 —— 卡片上数的就是那一类)。
   * 只随第一页;一个都没有的类不在里面。次序照 `MARKET_CATEGORIES`,「其他」最后。
   */
  categories: { category: MarketCategory; count: number; icons: (string | null)[] }[];
  fetchedAt: string;
}

/** 「最新」页那几种排法:`searchApps` 的几种,加上 `popular` = 安装数从高到低。 */
export type MarketListSort = AppSearchSort | 'popular';

export interface CloudMarketListOptions {
  /** 第几页,从 0 起。 */
  page?: number;
  /** 搜索词;空串 = 不搜。和 agent 的 app_search 同一条规矩(`searchApps`:按词打分,按相关度排)。 */
  search?: string;
  /** 只看这一类(`marketCategoryOf`)。 */
  category?: MarketCategory;
  /** 只看这样用的(`appSurfaces`)。 */
  surface?: AppSurface;
  /** 次序;不给 = 有搜索词按相关度、没有按名字。 */
  sort?: MarketListSort;
  /** 近期安装分数(`chat.market_install_ranking`),按 App id;排首页精选用。没有就只按 `featured`。 */
  scores?: ReadonlyMap<string, number>;
  /** 安装数的档位(`chat.market_install_counts`),按 App id;`sort: 'popular'` 用。 */
  installs?: ReadonlyMap<string, number>;
}

export interface CloudExtensionMarketOptions {
  /** 解开的包落在哪儿(应用可写的临时区),不是扩展安装根目录。 */
  stagingRoot: string;
  /**
   * 先下好、等人点头的那几份留在哪儿(`hold`),按包的 sha256 一份一个目录。和 staging 分开:下一次 `materialize` 扫 staging
   * 时扫不到它们 —— 首启那一页要连着备好几份,再一起问。
   */
  heldRoot: string;
  /** 这台咕咕关于自己的三个数。异步:app 版本在 dev 形态下要读 package.json。 */
  resolveHost: () => Promise<MarketHost>;
  /** 手上那份目录落在哪儿(market-snapshot.ts):下次启动打开 App 页先画它。 */
  snapshotStore: MarketSnapshotStore;
  /** 目录从哪个根取的(下载站的 `market/` 根):落下的那份根不同就不认。 */
  scope?: string;
  /** 一趟没取到的原话(进日志)。 */
  onRefreshFailure?: (error: unknown) => void;
  now?: () => number;
}

/** 市场上的一版,下好、核过、解开以后:目录、「代码在哪」、「这版改了什么」,和包的 sha256(留着等人点头时按它认)。 */
export interface MarketPrepared {
  sourceDir: string;
  source: MarketCodeSource;
  releaseNotes: string;
  sha256: string;
}

/** 解开的包落在哪儿。dot 前缀,与安装 staging 同一套「扫描永远看不见」的约定。 */
const STAGING_PREFIX = '.market-';

export class CloudExtensionMarket {
  private hostPromise: Promise<MarketHost> | null = null;
  /** 手上那份目录。任何一次新取都整份替换它 —— 列表、详情、更新、安装看到的始终是同一份。 */
  private readonly snapshot: MarketSnapshotSource;
  /**
   * The unpacked copies this process is using now (unpacked, not yet installed or discarded): the sweep of leftovers leaves
   * them. Two installs can be under way at once — the first-run set in the background and one the person started.
   */
  private readonly unpacking = new Set<string>();

  constructor(
    private readonly backend: MarketBackend,
    private readonly options: CloudExtensionMarketOptions
  ) {
    this.snapshot = marketSnapshotSource({
      readIndex: () => backend.readText('index.json'),
      store: options.snapshotStore,
      scope: options.scope,
      onFailure: options.onRefreshFailure,
      now: options.now,
    });
  }

  private host(): Promise<MarketHost> {
    this.hostPromise ??= this.options.resolveHost();
    return this.hostPromise;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // ── 目录 ───────────────────────────────────────────────────────────────

  /**
   * 市场目录。市场页(每一页、搜索)、更新检查、详情、README 都读手上那份(market-snapshot.ts:内存里的,没有就读落下的,
   * 从没取到过才等下载站)—— 打开 App 页不再等一趟下载站(owner 10-16)。`fresh` = 装的时候:装的必须是下载站此刻
   * 那一版,现取;取到的同样整份替换手上那份。
   * 10-08 这里禁过落盘缓存、按时效复用(A/B:撤回已在行上,卡片还是被撤回的那版 —— 两边各取各的,读到不同时刻)。
   * 现在两边只读这一份、后台取回来整份替换并报一次(`onRefreshed`),界面两边一起重读;每次打开照样去取,❌ 看它多旧。
   * 手上的是**原始目录**,兼容判定在读的时候按当前宿主重算。
   */
  private index(fresh: boolean): Promise<MarketSnapshot> {
    return fresh ? this.snapshot.fresh() : this.snapshot.current();
  }

  /**
   * 去下载站取一次目录,等它回来、说结果(变了 / 没变 / 没取到),不抛:打开 App 页时那一趟。同一时刻只有一趟在路上 ——
   * 同时打开的市场页、更新检查、安装都等这同一趟。
   */
  refresh(): Promise<MarketRefreshed> {
    return this.snapshot.refresh();
  }

  /** 每一趟去取的结果,不论谁叫的(打开页面、安装、首启):主进程据此告诉界面重读。返回退订。 */
  onRefreshed(listener: (refreshed: MarketRefreshed) => void): () => void {
    return this.snapshot.onRefreshed(listener);
  }

  private async app(extensionId: string, fresh = false): Promise<MarketIndexApp | null> {
    const { index } = await this.index(fresh);
    return index.apps.find((app) => app.id === extensionId) ?? null;
  }

  // ── 清单 ───────────────────────────────────────────────────────────────

  /**
   * 清单上的每一条,已经替这台机器挑好版本,按名字、id 排序后切出这一页。
   *
   * manifest 取自目录里登记的那份,所以画卡片、列权限**不必先下整个包** ——
   * 用户在点头之前看到的东西不该以「先把代码拉到本地」为代价。
   * 真正的判定仍在装的时候:那时读的是解包出来的 manifest.json,并且要与同意指纹对上。
   *
   * 读不出来的行**报告而不是跳过**:一个 manifest 存坏了的版本,是发布流程的事故,
   * 静默少一张卡片正是没人会发现的那种。它们只随第一页、不带搜索词时报一次。
   */
  async list(options: CloudMarketListOptions = {}): Promise<CloudMarketListing> {
    const page = options.page ?? 0;
    const needle = options.search ?? '';
    const { index, fetchedAt } = await this.index(false);
    const { extensions, invalid } = await this.entriesFrom(index.apps);
    const records = this.datedRecords(index.apps, extensions);
    // 搜索、「用在哪」、次序都是 `searchApps`(和 agent 的 app_search 同一份);类别按市场那张表(`marketCategoryOf`)筛。
    const searchSort = options.sort === 'popular' ? 'name' : options.sort;
    const { items } = searchApps(records, { query: needle, surface: options.surface, sort: searchSort });
    const installs = options.installs;
    const ordered = options.sort === 'popular' && installs
      ? items.slice().sort((a, b) => (installs.get(b.manifest.id) ?? 0) - (installs.get(a.manifest.id) ?? 0))
      : items;
    const matched = ordered
      .filter((record) => !options.category || marketCategoryOf(record.manifest) === options.category)
      .map((record) => (record as (typeof records)[number]).entry);
    const firstPage = page === 0 && queryWords(needle).length === 0;
    // 推荐页照样只看这样用的:精选、那几排都从筛过「用在哪」的那些里排。
    const surfaced = options.surface ? extensions.filter((entry) => appSurfaces(entry.manifest).includes(options.surface!)) : extensions;
    return {
      extensions: matched.slice(page * MARKET_PAGE_SIZE, (page + 1) * MARKET_PAGE_SIZE),
      invalid: firstPage ? invalid : [],
      total: matched.length,
      page,
      hasMore: (page + 1) * MARKET_PAGE_SIZE < matched.length,
      featured: firstPage ? featuredOf(surfaced, options.scores ?? new Map()) : [],
      home: firstPage ? marketHome(surfaced) : [],
      categories: page === 0 ? categoryCards(items.map((record) => (record as (typeof records)[number]).entry)) : [],
      fetchedAt: new Date(fetchedAt).toISOString(),
    };
  }

  /** 目录里的每一条加上它第一版发布的时刻,做成 `searchApps` 的记录(带着原来那一条)。 */
  private datedRecords(apps: readonly MarketIndexApp[], extensions: readonly CloudMarketEntry[]) {
    const first = new Map(apps.map((app) => [app.id, app.versions.map((version) => version.publishedAt).sort()[0] ?? '']));
    return extensions.map((entry) => ({
      manifest: entry.manifest,
      state: 'market' as const,
      version: entry.version,
      publishedAt: entry.publishedAt,
      firstPublishedAt: first.get(entry.manifest.id) || entry.publishedAt,
      entry,
    })) satisfies AppSearchRecord[];
  }

  /**
   * 市场上这台机器装得了、没有弃用的每一个 App(各自给这台机器的那一版):群里打开一个这里没有 App 能开的文件时,
   * 从这些里找能开它的那个推荐;首启默认组也从这些里挑标了 `firstRun` 的(161 10-15)。用手上那份目录,还没取过才取。
   */
  async offers(): Promise<CloudMarketEntry[]> {
    return (await this.entries()).filter((entry) => entry.compat === null && !entry.deprecated);
  }

  /**
   * 市场上的每一个 App(各自给这台机器的那一版,装不了的带着 compat),加上它第一版发布的时刻:agent 的 app_search 按它们
   * 筛选、排序(app-search.ts)。用手上那份目录,❌ 另取一趟。
   */
  async entries(): Promise<(CloudMarketEntry & { firstPublishedAt: string })[]> {
    const { index } = await this.index(false);
    const { extensions } = await this.entriesFrom(index.apps);
    return this.datedRecords(index.apps, extensions).map(({ entry, firstPublishedAt }) => ({ ...entry, firstPublishedAt }));
  }

  /**
   * 一个扩展当前给这台机器的那一版(装着的扩展开详情、更新确认框要它的更新说明)。不在市场上就 null。
   * `fresh` = 安装(app_install)查它:咕咕开着时新上架的 App,手上那份里还没有。
   */
  async entry(extensionId: string, fresh = false): Promise<CloudMarketEntry | null> {
    const app = await this.app(extensionId, fresh);
    if (!app) return null;
    const { extensions } = await this.entriesFrom([app]);
    return extensions[0] ?? null;
  }

  /** 目录里的 App → 卡片(market-entries.ts:手机读同一份目录,规矩只有这一份)。 */
  private async entriesFrom(
    apps: readonly MarketIndexApp[]
  ): Promise<{ extensions: CloudMarketEntry[]; invalid: InvalidMarketRow[] }> {
    return marketEntriesFrom(apps, await this.host(), (relativePath) => this.backend.urlOf(relativePath));
  }

  // ── 版本历史 / README ──────────────────────────────────────────────────

  /** 一个扩展的全部版本,最新的在前;每一版带这台机器装不装得了、撤回没有。不在市场上就是空的。 */
  async history(extensionId: string): Promise<MarketVersionHistoryEntry[]> {
    return marketHistoryFrom(await this.app(extensionId), await this.host());
  }

  /** 这一版包里的 README(没有就 null)。详情面板打开时才取。 */
  async readme(extensionId: string, version: string): Promise<string | null> {
    const readme = (await this.app(extensionId))?.versions.find((entry) => entry.version === version)?.readme;
    return readme ? this.backend.readText(readme) : null;
  }

  // ── 启动时那一趟检查 ───────────────────────────────────────────────────

  /**
   * 装着的这些扩展,各自有什么要告诉用户的:有新版 / 装的这版被撤回了 / 扩展已弃用。
   * 只读、只比对;❌ 不下载、❌ 不安装 —— 与 app 更新的 spec 同构。读的是和市场页同一份目录(手上那份):
   * 后台取回来变了,界面让市场页和这里一起重读,两边永远是同一刻。
   */
  async updatesFor(installed: readonly { id: string; version: string; fromMarket?: boolean }[]): Promise<MarketUpdatesSummary> {
    const summary: MarketUpdatesSummary = {
      checkedAt: new Date(this.now()).toISOString(),
      updates: {},
      yanked: {},
      deprecated: {},
      gone: [],
    };
    if (installed.length === 0) return summary;
    const { index } = await this.index(false);
    return marketUpdatesFrom(index, await this.host(), installed, summary.checkedAt);
  }

  // ── 落地 ───────────────────────────────────────────────────────────────

  /**
   * 把市场上那一版变成机器上的一个目录,交给安装路径。目录现取:装的是现在还在市场上的那一版。
   * 一并交回这一版的「代码在哪」和「这版改了什么」:同意框要写的正是装的这一版的,而只有这里手上拿着那一行 ——
   * 从版本历史装一个旧版时,别处(当前那一版、已取到的页)都对不上。
   *
   * 顺序是硬的:**先比对指纹,再解包**。反过来的话,一个字节被换过的包已经躺在磁盘上了,
   * 而「装之前才发现」与「根本没落地」是两种事故等级。
   */
  async materialize(
    extensionId: string,
    version: string,
    onProgress?: (received: number, total: number) => void
  ): Promise<MarketPrepared> {
    const host = await this.host();
    const row = (await this.app(extensionId, true))?.versions.find((entry) => entry.version === version);
    if (!row) {
      // 可见状态会变(下架、版本不存在)。此时告诉用户「这一版已经不在市场上了」,
      // ❌ 不去猜一个别的版本装上 —— 他点的是这一版。
      throw new Error(`Extension ${extensionId}@${version} is no longer available`);
    }
    if (row.yanked) {
      throw new Error(`Extension ${extensionId}@${version} was withdrawn: ${row.yanked.reason}`);
    }
    const compat = compatOf(row, host);
    if (compat) {
      // 每条安装路径(Apps 页、群里的「用 X 打开」、首启、agent 的 app_install)都走到这里,兼容性只在这里判一次。
      // 界面上这一版的按钮本来就是灰的;安装器只认协议号、不认最低咕咕版本,所以下载之前要挡。
      throw new Error(compatRefusal(extensionId, version, compat));
    }

    const bytes = await this.backend.download(row.bundle, {
      expectedBytes: row.bytes,
      onProgress: onProgress ? (received) => onProgress(received, row.bytes) : undefined,
    });
    if (bytes.byteLength !== row.bytes) {
      throw new Error(
        `Bundle size mismatch for ${extensionId}@${version}: expected ${row.bytes} bytes, got ${bytes.byteLength}`
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== row.sha256) {
      // 这句话是这条链路存在的理由:安装同意指纹只绑 manifest,不绑代码;
      // 能换掉下载站上那个文件的人,就能在一份已被点头的权限清单底下换掉代码。
      throw new Error(
        `Bundle fingerprint mismatch for ${extensionId}@${version}: the file does not match what was published. Nothing was unpacked.`
      );
    }

    this.sweepStaging();
    const target = path.join(this.options.stagingRoot, `${STAGING_PREFIX}${extensionId}-${randomHex()}`);
    fs.mkdirSync(target, { recursive: true });
    this.unpacking.add(target);
    try {
      await unpackBundle(bytes, target);
      const manifestPath = path.join(target, EXTENSION_MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`Bundle has no ${EXTENSION_MANIFEST_FILENAME}`);
      }
      const parsed = safeParseExtensionManifest(
        JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown
      );
      if (!parsed.ok) {
        throw new Error(`Bundle manifest is invalid:\n- ${parsed.issues.join('\n- ')}`);
      }
      if (parsed.manifest.id !== extensionId || parsed.manifest.version !== version) {
        // 包里的 manifest 与市场上那张卡片说的必须一致 —— 否则用户读的权限清单
        // 与他装进去的那份是两回事,而同意指纹只保证「点头之后没被改」,不保证「点头看的就是它」。
        throw new Error(
          `Bundle contains ${parsed.manifest.id}@${parsed.manifest.version}, not ${extensionId}@${version}`
        );
      }
      return { sourceDir: target, source: row.source, releaseNotes: row.releaseNotes, sha256: row.sha256 };
    } catch (error) {
      this.unpacking.delete(target);
      fs.rmSync(target, { recursive: true, force: true });
      throw error;
    }
  }

  // ── 等人点头的那几份 ─────────────────────────────────────────────────────

  /**
   * 下好、核过、解开的这一份先留着,等人点头(`installExtensionFromMarket` 的 `consent: return`):点了头那一次直接用它,
   * ❌ 再下一遍。按包的 sha256 一份一个目录;同一个包再留一次就换成新解开的这份。
   */
  hold(prepared: MarketPrepared): MarketPrepared {
    const target = path.join(this.options.heldRoot, prepared.sha256);
    fs.mkdirSync(this.options.heldRoot, { recursive: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(prepared.sourceDir, target);
    this.unpacking.delete(prepared.sourceDir);
    return { ...prepared, sourceDir: target };
  }

  /**
   * 这一版留着的那一份;没留(另一个进程、或者已经装过删掉了)就 null,调用方照常 `materialize`。
   * 认的是目录里这一版的 sha256 —— 手上那份目录就是留它那一刻读的,所以不再现取。
   */
  async held(extensionId: string, version: string): Promise<MarketPrepared | null> {
    const row = (await this.app(extensionId))?.versions.find((entry) => entry.version === version);
    if (!row) return null;
    const sourceDir = path.join(this.options.heldRoot, row.sha256);
    if (!fs.existsSync(path.join(sourceDir, EXTENSION_MANIFEST_FILENAME))) return null;
    return { sourceDir, source: row.source, releaseNotes: row.releaseNotes, sha256: row.sha256 };
  }

  /** 用完的一份(装好了、没装上、人说了不装):不管它在 staging 还是留着的地方,都删掉。 */
  discard(prepared: Pick<MarketPrepared, 'sourceDir'>): void {
    this.unpacking.delete(prepared.sourceDir);
    fs.rmSync(prepared.sourceDir, { recursive: true, force: true });
  }

  /**
   * 进程第一次用市场时,扫掉上一次留着却没等到点头的那几份(人关了页面、咕咕退了)。不加定时清理:
   * 留着的只在这一次运行里有用,下一次要用就是重新下。
   */
  sweepHeld(): void {
    fs.rmSync(this.options.heldRoot, { recursive: true, force: true });
  }

  /**
   * 清掉上一次留下的解包目录。
   *
   * 它们是安装的输入,安装完就没用了;而安装可能在任何一步失败或被用户取消,
   * 所以没有一个「装完删」的时刻是可靠的 —— 下一次要用的时候顺手扫,是唯一不会漏的位置。
   */
  private sweepStaging(): void {
    const root = this.options.stagingRoot;
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
      const dir = path.join(root, entry.name);
      if (this.unpacking.has(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * 解开归档。
 *
 * 逐条判路径,一条不合规就**整包拒绝**(见 `bundleEntryRejection` 的理由)。
 * 写文件是我们自己写的 —— 不经过任何「按归档里的属性还原」的路径,所以归档里即便标了
 * 符号链接或可执行位,落到磁盘上的也只是普通文件。这是与本地安装(刻意保留符号链接)
 * 的关键区别:那边的文件夹是用户自己的,这边的包没有任何人看过。
 *
 * 字节是**边解边数**的:一条超过上限当场停,❌ 不是整个文件解完到内存再数 —— 一个 25 MiB 的包
 * 放一个能胀到几个 G 的文件,后一种数法还没跑到就先把内存吃了。
 */
/** Why this computer cannot install that version — said where an install fetches it, and on its row in an agent's catalog_list. */
export function compatRefusal(extensionId: string, version: string, compat: NonNullable<MarketCompat>): string {
  return compat.reason === 'needs-newer-app'
    ? `Extension ${extensionId}@${version} needs gugu ${compat.minAppVersion} or newer — ask the person to update gugu`
    : `Extension ${extensionId}@${version} targets apiVersion ${compat.apiVersion}, which this gugu no longer runs; its author has to update it`;
}

export async function unpackBundle(bytes: Uint8Array, targetDir: string): Promise<void> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files);
  // 先把条目数和每条路径都判一遍,再落第一个字节:一个包里有一条越界路径,它整体就不可信。判据共享(手机装包同一份,L9)。
  const refusal = archiveRefusal(entries.map((entry) => entry.name));
  if (refusal) throw new Error(refusal);
  let unpacked = 0;
  for (const entry of entries) {
    const destination = path.join(targetDir, entry.name);
    if (entry.dir) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const source = entry.nodeStream('nodebuffer');
      const sink = fs.createWriteStream(destination);
      let failed = false;
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        source.unpipe(sink);
        sink.destroy();
        // jszip 的流是自家实现,不带 destroy;pause 之后不再产出。
        (source as { pause?: () => void }).pause?.();
        reject(error);
      };
      source.on('data', (chunk: Buffer) => {
        unpacked += chunk.byteLength;
        const tooMuch = unpackedTooMuch(unpacked);
        if (tooMuch) fail(new Error(tooMuch));
      });
      source.on('error', fail);
      sink.on('error', fail);
      sink.on('finish', () => {
        if (!failed) resolve();
      });
      source.pipe(sink);
    });
  }
}

function randomHex(): string {
  return randomBytes(4).toString('hex');
}

/** 「类别」页的卡片:每一类几个、前三个的图标,次序照 `MARKET_CATEGORIES`、「其他」最后;一个都没有的类不出卡。 */
function categoryCards(entries: readonly CloudMarketEntry[]): CloudMarketListing['categories'] {
  return [...MARKET_CATEGORIES, 'other' as const].flatMap((category) => {
    const members = entries.filter((entry) => marketCategoryOf(entry.manifest) === category);
    return members.length ? [{ category, count: members.length, icons: members.slice(0, 3).map((entry) => entry.iconUrl) }] : [];
  });
}
