import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bundleEntryRejection,
  MARKET_PAGE_SIZE,
  type MarketIndex,
  type MarketIndexApp,
  type MarketIndexVersion,
} from '@shared/extensions/market';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { MarketRefreshed, MarketSnapshotStore } from '@shared/extensions/market-snapshot';
import { CloudExtensionMarket, type BundleDownloadOptions, type MarketBackend } from './market-catalog';

/**
 * App 市场(#5410;10-08 起数据源是下载站上的一份 `market/index.json`)。判的是「从下载站下来的那份能不能落地」这件事本身:
 * 指纹对不上、包里有越界路径、包里的 manifest 与目录上那张卡片不是同一版 —— 一律不落地。
 * 2026-09-14 加上版本这件事:替这台机器挑版本、撤回的不装、有新版/被撤回/已弃用的提示、目录缓存。
 */

const COMMIT = '6f46446' + 'a'.repeat(33);

function manifestOf(id: string, version = '1.0.0') {
  return {
    apiVersion: EXTENSION_API_VERSION,
    id,
    name: `Extension ${id}`,
    version,
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Main' }] },
  };
}

async function zipOf(files: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content, { date: new Date(0) });
  return new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
}

function versionFor(
  bytes: Uint8Array,
  id: string,
  version = '1.0.0',
  extra: Partial<MarketIndexVersion> = {}
): MarketIndexVersion {
  return {
    version,
    manifest: manifestOf(id, version),
    apiVersion: EXTENSION_API_VERSION,
    minAppVersion: '0.1.0',
    releaseNotes: `notes for ${version}`,
    publishedAt: `2026-09-${version.replace(/\./g, '')}T00:00:00Z`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
    bundle: `bundles/${id}/${version}.zip`,
    icon: null,
    readme: null,
    source: { repo: 'shuxueshuxue/gugu-apps', path: `examples/${id}`, commit: COMMIT },
    yanked: null,
    ...extra,
  };
}

function appOf(id: string, versions: MarketIndexVersion[], extra: Partial<MarketIndexApp> = {}): MarketIndexApp {
  return { id, deprecated: null, versions, ...extra };
}

/** 下载站:一份目录 + 若干文件。`index.json` 每被取一次记一次,判缓存与「现取」;`down` = 这会儿连不上。 */
class FakeSite implements MarketBackend {
  indexReads = 0;
  downloads = 0;
  down = false;
  constructor(
    public index: MarketIndex | unknown,
    private readonly files: Record<string, Uint8Array | string> = {}
  ) {}
  readText(relativePath: string): Promise<string> {
    if (relativePath === 'index.json') {
      this.indexReads += 1;
      if (this.down) return Promise.reject(new Error('market index.json: fetch failed'));
      return Promise.resolve(JSON.stringify(this.index));
    }
    const file = this.files[relativePath];
    if (typeof file !== 'string') return Promise.reject(new Error(`market ${relativePath}: HTTP 404`));
    return Promise.resolve(file);
  }
  download(relativePath: string, options: BundleDownloadOptions): Promise<Uint8Array> {
    this.downloads += 1;
    const bytes = this.files[relativePath];
    if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error(`market ${relativePath}: HTTP 404`));
    options.onProgress?.(Math.min(bytes.byteLength, 1));
    options.onProgress?.(bytes.byteLength);
    return Promise.resolve(bytes);
  }
  urlOf(relativePath: string): string {
    return `https://download.example/market/${relativePath}`;
  }
}

function siteOf(apps: MarketIndexApp[], files: Record<string, Uint8Array | string> = {}): FakeSite {
  return new FakeSite({ apps }, files);
}

/** 手上那份目录落下的地方(主进程里是 userData 下一个文件):一段文本。 */
function memoryStore(text: string | null = null): MarketSnapshotStore & { text: string | null } {
  const store = {
    text,
    read: () => Promise.resolve(store.text),
    write: (next: string) => {
      store.text = next;
      return Promise.resolve();
    },
  };
  return store;
}

let root: string;
let clock: number;

function marketOf(backend: MarketBackend, appVersion = '0.2.40', snapshotStore: MarketSnapshotStore = memoryStore()): CloudExtensionMarket {
  return new CloudExtensionMarket(backend, {
    stagingRoot: path.join(root, 'staging'),
    heldRoot: path.join(root, 'held'),
    resolveHost: () => Promise.resolve({ appVersion, apiVersionMin: EXTENSION_API_VERSION, apiVersionMax: EXTENSION_API_VERSION }),
    snapshotStore,
    scope: 'https://download.example/market/',
    now: () => clock,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-market-'));
  clock = 1_700_000_000_000;
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bundleEntryRejection', () => {
  it('放行老实的相对路径', () => {
    expect(bundleEntryRejection('manifest.json')).toBeNull();
    expect(bundleEntryRejection('assets/app.js')).toBeNull();
  });

  it('拒绝越界、绝对与畸形路径', () => {
    expect(bundleEntryRejection('../outside.js')).toContain('escapes');
    expect(bundleEntryRejection('assets/../../outside.js')).toContain('escapes');
    expect(bundleEntryRejection('/etc/passwd')).toContain('absolute');
    expect(bundleEntryRejection('C:\\Windows\\note.txt')).toContain('backslash');
    expect(bundleEntryRejection('')).toContain('empty');
  });

  it('拒绝顶层的 _gugu/:那是平台运行时的保留路径,包里的那份永远不会被供出去', () => {
    expect(bundleEntryRejection('_gugu/1/gugu.js')).toContain('reserved');
    expect(bundleEntryRejection('_GUGU/x.js')).toContain('reserved');
    // 对照:只有顶层是保留的。
    expect(bundleEntryRejection('lib/_gugu/x.js')).toBeNull();
    expect(bundleEntryRejection('_gugux.js')).toBeNull();
  });
});

describe('CloudExtensionMarket.list', () => {
  it('读不出来的行报告而不是跳过', async () => {
    const good = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('good-one', [versionFor(good, 'good-one')]),
      appOf('broken', [versionFor(good, 'broken', '1.0.0', { manifest: { apiVersion: EXTENSION_API_VERSION, id: 'broken' } })]),
    ]);
    const { extensions, invalid } = await marketOf(site).list();
    expect(extensions.map((entry) => entry.manifest.id)).toEqual(['good-one']);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.extensionId).toBe('broken');
  });

  it('manifest 与目录里的 id 对不上也算读不出来', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('listed-as', [versionFor(bytes, 'listed-as', '1.0.0', { manifest: manifestOf('says-otherwise') })])]);
    const { extensions, invalid } = await marketOf(site).list();
    expect(extensions).toHaveLength(0);
    expect(invalid[0]!.reason).toContain('says-otherwise');
  });

  it('形状不对的目录照实抛,❌ 当成空市场', async () => {
    await expect(marketOf(new FakeSite({ apps: [{ id: 'x' }] })).list()).rejects.toThrow(/index\.json is malformed/);
    // 目录里的路径只能落在 market 根下面:`..` 与绝对地址都算形状不对。
    const bytes = await zipOf({ 'manifest.json': '{}' });
    for (const bundle of ['../releases/desktop/latest/x.zip', 'https://elsewhere.example/x.zip']) {
      const site = siteOf([appOf('escape', [versionFor(bytes, 'escape', '1.0.0', { bundle })])]);
      await expect(marketOf(site).list()).rejects.toThrow(/malformed/);
    }
  });

  it('目录里那些字段一并交出来:图标地址、更新说明、弃用、代码在哪', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('rich', [versionFor(bytes, 'rich', '1.0.0', { icon: 'media/rich/abc.png' })], {
        deprecated: { note: '换用 better-one', replacedBy: 'better-one' },
      }),
    ]);
    const { extensions } = await marketOf(site).list();
    expect(extensions[0]).toMatchObject({
      iconUrl: 'https://download.example/market/media/rich/abc.png',
      releaseNotes: 'notes for 1.0.0',
      deprecated: { note: '换用 better-one', replacedBy: 'better-one' },
      compat: null,
      newerNeedsApp: null,
      source: { repo: 'shuxueshuxue/gugu-apps', path: 'examples/rich', commit: COMMIT },
    });
  });

  it('最新版要新咕咕时,退回去给这台机器能装的最新一版,并指出更新的那版需要新咕咕', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('ext', [
        versionFor(bytes, 'ext', '1.0.0'),
        versionFor(bytes, 'ext', '1.1.0'),
        versionFor(bytes, 'ext', '1.3.0', { minAppVersion: '9.9.9' }),
      ]),
    ]);
    const { extensions } = await marketOf(site).list();
    expect(extensions).toHaveLength(1);
    expect(extensions[0]).toMatchObject({ version: '1.1.0', compat: null, newerNeedsApp: '1.3.0' });
    expect(extensions[0]!.manifest.version).toBe('1.1.0');
  });

  it('一版都装不了 → 卡片留着、compat 说原因,❌ 不消失也不算读不出来', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('future', [versionFor(bytes, 'future', '2.0.0', { minAppVersion: '9.9.9' })])]);
    const { extensions, invalid } = await marketOf(site).list();
    expect(invalid).toHaveLength(0);
    expect(extensions[0]).toMatchObject({
      version: '2.0.0',
      compat: { reason: 'needs-newer-app', minAppVersion: '9.9.9' },
    });
  });

  it('全撤回了 → 清单上没有这一行', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('pulled', [versionFor(bytes, 'pulled', '1.0.0', { yanked: { reason: 'bad' } })])]);
    const { extensions, invalid, total } = await marketOf(site).list();
    expect([extensions.length, invalid.length, total]).toEqual([0, 0, 0]);
  });

  it('协议号比宿主新的 manifest 解析不过,但那是兼容问题:卡片照画,写「需要更新咕咕」', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('proto2', [
        versionFor(bytes, 'proto2', '2.0.0', {
          apiVersion: EXTENSION_API_VERSION + 1,
          manifest: { ...manifestOf('proto2', '2.0.0'), apiVersion: EXTENSION_API_VERSION + 1, brandNewField: true },
        }),
      ]),
    ]);
    const { extensions, invalid } = await marketOf(site).list();
    expect(invalid).toHaveLength(0);
    expect(extensions[0]).toMatchObject({ version: '2.0.0', compat: { reason: 'needs-newer-app' } });
    expect(extensions[0]!.manifest.name).toBe('Extension proto2');
  });

  it('兼容判定不进缓存:同一份缓存,换一台更老的咕咕读,结论跟着变', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('ext', [versionFor(bytes, 'ext', '1.0.0', { minAppVersion: '0.2.40' })])]);
    expect((await marketOf(site, '0.2.40').list()).extensions[0]!.compat).toBeNull();
    expect((await marketOf(site, '0.2.39').list()).extensions[0]!.compat).toMatchObject({ reason: 'needs-newer-app' });
  });

  it('一页 MARKET_PAGE_SIZE 张、按名字排、带总数、说清后面还有没有;两页之间不重复不漏', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const apps = Array.from({ length: MARKET_PAGE_SIZE + 5 }, (_, index) => {
      const id = `ext-${String(index).padStart(2, '0')}`;
      return appOf(id, [versionFor(bytes, id)]);
    }).reverse();
    const site = siteOf(apps);
    const market = marketOf(site);
    const first = await market.list({ page: 0 });
    expect(first.extensions).toHaveLength(MARKET_PAGE_SIZE);
    expect(first).toMatchObject({ total: MARKET_PAGE_SIZE + 5, page: 0, hasMore: true });
    expect(first.extensions[0]!.manifest.id).toBe('ext-00');
    const second = await market.list({ page: 1 });
    expect(second.extensions).toHaveLength(5);
    expect(second).toMatchObject({ page: 1, hasMore: false });
    const ids = [...first.extensions, ...second.extensions].map((entry) => entry.manifest.id);
    expect(new Set(ids).size).toBe(MARKET_PAGE_SIZE + 5);
    // 翻页是对同一份目录切片,❌ 每页一趟网络。
    expect(site.indexReads).toBe(1);
  });

  // owner 10-22「多借鉴 google play」:类别是一页卡片,一类一页;筛、排都是 `searchApps`(和 agent 的 app_search 同一份)。
  it('类别:按市场类别表筛一类;卡片照表的次序、「其他」最后,带个数和前三个图标;没有搜索词时按名字排', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const withCategory = (id: string, categories?: string[]) =>
      appOf(id, [versionFor(bytes, id, '1.0.0', { manifest: { ...manifestOf(id), ...(categories ? { categories } : {}) } })]);
    const site = siteOf([
      withCategory('a-game', ['games']),
      withCategory('b-dev', ['developer']),
      withCategory('c-none'),
      withCategory('d-notes', ['productivity']),
      withCategory('e-papers', ['games', 'research']),
      withCategory('f-arxiv', ['research']),
      withCategory('g-chat', ['social']),
    ]);
    const market = marketOf(site);
    const all = await market.list({ page: 0 });
    expect(all.extensions.map((entry) => entry.manifest.id)).toEqual(['a-game', 'b-dev', 'c-none', 'd-notes', 'e-papers', 'f-arxiv', 'g-chat']);
    // 第一个写在表里的类别算数:e-papers 写的是 games、research → 游戏。
    expect(all.categories.map((card) => [card.category, card.count])).toEqual([
      ['research', 1],
      ['productivity', 1],
      ['developer', 1],
      ['games', 2],
      ['social', 1],
      ['other', 1],
    ]);
    expect((await market.list({ page: 0, category: 'games' })).extensions.map((entry) => entry.manifest.id)).toEqual(['a-game', 'e-papers']);
    expect((await market.list({ page: 0, category: 'other' })).extensions.map((entry) => entry.manifest.id)).toEqual(['c-none']);
    expect((await market.list({ page: 1 })).categories).toEqual([]);
  });

  it('「用在哪」:任务侧栏 / Agent 工具 / 群组照 manifest 的声明筛', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const declaring = (id: string, extra: Record<string, unknown>) =>
      appOf(id, [versionFor(bytes, id, '1.0.0', { manifest: { ...manifestOf(id), ...extra } })]);
    const site = siteOf([
      declaring('page', {}),
      declaring('tools', { contributes: { mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } }),
      declaring('group-files', { contributes: { tabs: [{ name: 'main', title: 'Main', opensFiles: { chat: ['.pdf'] } }] } }),
    ]);
    const market = marketOf(site);
    const ids = async (surface: 'task' | 'agent' | 'group') => (await market.list({ page: 0, surface })).extensions.map((entry) => entry.manifest.id);
    expect(await ids('task')).toEqual(['page']);
    expect(await ids('agent')).toEqual(['tools']);
    expect(await ids('group')).toEqual(['group-files']);
  });

  it('热门:按安装数从高到低,同数按名字;没有安装数的排在后面;读不到安装数时按名字', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf(['app-a', 'app-b', 'app-c', 'app-d'].map((id) => appOf(id, [versionFor(bytes, id)])));
    const market = marketOf(site);
    const installs = new Map([['app-c', 50], ['app-a', 5], ['app-d', 50]]);
    expect((await market.list({ page: 0, sort: 'popular', installs })).extensions.map((entry) => entry.manifest.id)).toEqual(['app-c', 'app-d', 'app-a', 'app-b']);
    expect((await market.list({ page: 0, sort: 'popular' })).extensions.map((entry) => entry.manifest.id)).toEqual(['app-a', 'app-b', 'app-c', 'app-d']);
  });

  it('首页精选:近期安装分数高的在前,不够 3 张用标了 featured 的按索引次序补;停止维护的、首启组的不进;只随不带搜索词的第一页', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('old', [versionFor(bytes, 'old')], { featured: true, deprecated: { note: null, replacedBy: null } }),
      appOf('notes', [versionFor(bytes, 'notes')], { featured: true }),
      appOf('boot', [versionFor(bytes, 'boot')], { featured: true, firstRun: true }),
      appOf('plain', [versionFor(bytes, 'plain')]),
      appOf('hot', [versionFor(bytes, 'hot')]),
      appOf('warm', [versionFor(bytes, 'warm')]),
    ]);
    const market = marketOf(site);
    const ids = (entries: { manifest: { id: string } }[]) => entries.map((entry) => entry.manifest.id);
    // 没有分数(读不到 / 冷启动):只剩官方标的,停维的、首启组的不算。
    expect(ids((await market.list({ page: 0 })).featured)).toEqual(['notes']);
    // 有分数:高的在前;首启组的分数再高也不进;不够 3 张接着用官方标的补。
    const scores = new Map([['warm', 1.5], ['hot', 4], ['boot', 9], ['old', 7]]);
    expect(ids((await market.list({ page: 0, scores })).featured)).toEqual(['hot', 'warm', 'notes']);
    expect((await market.list({ page: 0, scores })).extensions.find((entry) => entry.manifest.id === 'plain')?.featured).toBe(false);
    expect((await market.list({ page: 0, search: 'notes', scores })).featured).toEqual([]);
    expect((await market.list({ page: 1, scores })).featured).toEqual([]);
  });

  it('首页那几排:Agent 工具 → 群组协作 → 更多 App(按最近更新);每个 App 只出现一次,凑不够两个的不成排;停维的不进;只随不带搜索词的第一页', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const app = (id: string, version: string, extra: Record<string, unknown>, more: Partial<MarketIndexApp> = {}) =>
      appOf(id, [versionFor(bytes, id, version, { manifest: { ...manifestOf(id, version), name: id, ...extra } })], more);
    const agentOnly = { contributes: { mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } };
    const site = siteOf([
      app('browser', '1.0.1', agentOnly, { featured: true }),
      app('computer', '1.0.2', { contributes: { tabs: [{ name: 'settings', title: 'Settings', hostPage: 'settings' }], mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } }),
      // 给 agent 工具、自己有一页、又打开群文件:不算「Agent 工具」那种(它有自己的页),归群组协作。
      app('papers', '1.0.3', { contributes: { tabs: [{ name: 'shelf', title: 'Papers' }, { name: 'reader', title: 'Papers', opensFiles: { chat: ['.pdf'] } }], mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } }),
      // 只给 agent 工具、没有自己的页(只有宿主画的设置页),又打开群文件:在 Agent 工具那一排出现过,群组那一排不再列它。
      app('scanner', '1.0.8', { contributes: { tabs: [{ name: 'settings', title: 'Settings', hostPage: 'settings' }, { name: 'view', title: 'Scan', opensFiles: { chat: ['.scan'] } }], mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } }),
      app('slides', '1.0.4', { contributes: { tabs: [{ name: 'main', title: 'Slides', opensFiles: { chat: ['.pptx'] } }] } }, { featured: true }),
      app('soup', '1.0.5', { contributes: { tabs: [{ name: 'main', title: 'Soup' }] }, permissions: { capabilities: ['chat:read'] } }),
      app('calendar', '1.0.6', {}),
      app('board', '1.0.7', {}),
      app('retired', '1.0.9', agentOnly, { deprecated: { note: null, replacedBy: null } }),
    ]);
    const market = marketOf(site);
    const { home } = await market.list({ page: 0 });
    const ids = (entries: { manifest: { id: string } }[]) => entries.map((entry) => entry.manifest.id);
    expect(home.map((section) => [section.kind, ids(section.entries)])).toEqual([
      ['agent', ['scanner', 'computer', 'browser']],
      ['group', ['soup', 'slides', 'papers']],
      ['more', ['board', 'calendar']],
    ]);
    // 推荐页也照「用在哪」筛:选了群组,精选和那几排都只从群组那几个里排(❌ 拿整份目录排)。scanner 也打开群文件:
    // 筛过以后 Agent 工具那一排只剩它一个、不成排,它落进群组那一排。
    const grouped = await market.list({ page: 0, surface: 'group' });
    expect(grouped.home.map((section) => [section.kind, ids(section.entries)])).toEqual([['group', ['scanner', 'soup', 'slides', 'papers']]]);
    expect(grouped.extensions.map((entry) => entry.manifest.id).sort()).toEqual(['papers', 'scanner', 'slides', 'soup']);
    expect(ids((await market.list({ page: 0 })).featured)).toEqual(['browser', 'slides']);
    expect(ids(grouped.featured)).toEqual(['slides']);
    expect((await market.list({ page: 0, search: 'board' })).home).toEqual([]);
    expect((await market.list({ page: 1 })).home).toEqual([]);
  });

  it('首页:凑不够两个的一排不成排,它的 App 留给后面那一排', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('tools', [versionFor(bytes, 'tools', '1.0.1', { manifest: { ...manifestOf('tools', '1.0.1'), contributes: { mcpServers: [{ tools: 'tools.js' }] }, permissions: { capabilities: ['agents:tools'] } } })]),
      appOf('plain', [versionFor(bytes, 'plain', '1.0.2')]),
    ]);
    const { home } = await marketOf(site).list({ page: 0 });
    expect(home.map((section) => [section.kind, section.entries.map((entry) => entry.manifest.id)])).toEqual([['more', ['plain', 'tools']]]);
  });

  it('搜索按相关度排(和 agent 的 app_search 同一条规矩):命中词多的在前,❌ 按名字', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('alpha', [versionFor(bytes, 'alpha', '1.0.0', { manifest: { ...manifestOf('alpha'), name: 'Alpha notes' } })]),
      appOf('zulu', [versionFor(bytes, 'zulu', '1.0.0', { manifest: { ...manifestOf('zulu'), name: 'Zulu board', description: 'notes on a board' } })]),
    ]);
    const hits = await marketOf(site).list({ search: 'board notes' });
    expect(hits.extensions.map((entry) => entry.manifest.id)).toEqual(['zulu', 'alpha']);
  });

  it('搜索按名字 / 简介 / id 筛同一份目录,不区分大小写', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('regex-forge', [versionFor(bytes, 'regex-forge')]), appOf('diff-lens', [versionFor(bytes, 'diff-lens')])]);
    const hits = await marketOf(site).list({ search: '  Regex ' });
    expect(hits.extensions.map((entry) => entry.manifest.id)).toEqual(['regex-forge']);
    expect(hits.total).toBe(1);
  });

  it('entry():一个扩展当前给这台机器的那一版;不在市场上就 null', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const market = marketOf(siteOf([appOf('one', [versionFor(bytes, 'one')]), appOf('two', [versionFor(bytes, 'two')])]));
    expect((await market.entry('two'))?.manifest.id).toBe('two');
    expect(await market.entry('nope')).toBeNull();
  });

  it('offers():群里「用 X 打开」挑的那些 —— 这台机器装得了、没有弃用的每一个,不分页', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('ok', [versionFor(bytes, 'ok')]),
      appOf('future', [versionFor(bytes, 'future', '2.0.0', { minAppVersion: '9.9.9' })]),
      appOf('old', [versionFor(bytes, 'old')], { deprecated: { note: null, replacedBy: 'ok' } }),
      ...Array.from({ length: MARKET_PAGE_SIZE }, (_, index) => appOf(`more-${index}`, [versionFor(bytes, `more-${index}`)])),
    ]);
    const offers = await marketOf(site).offers();
    expect(offers.map((entry) => entry.manifest.id)).toContain('ok');
    expect(offers.map((entry) => entry.manifest.id)).not.toContain('future');
    expect(offers.map((entry) => entry.manifest.id)).not.toContain('old');
    expect(offers).toHaveLength(MARKET_PAGE_SIZE + 1);
  });
});

describe('CloudExtensionMarket 手上那份目录', () => {
  // owner 10-16「打开 app 页每次都要刷新比较长的时间……本地有缓存啊」:打开 App 页(清单、更新检查)从手上那份答,❌ 等下载站。
  it('从没取到过才等那一趟;之后翻页、搜索、更新检查都读同一份,不再去取', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('one', [versionFor(bytes, 'one')])]);
    const market = marketOf(site);
    await market.list();
    expect(site.indexReads).toBe(1);
    await market.list({ page: 1 });
    await market.list({ search: 'one' });
    await market.list();
    await market.updatesFor([{ id: 'one', version: '1.0.0' }]);
    expect(site.indexReads).toBe(1);
  });

  it('下次启动(新的一个、同一处落盘)先给落下的那份:❌ 去下载站(那边已经是另一份),清单和更新检查都是落下的那份', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const store = memoryStore();
    await marketOf(siteOf([appOf('one', [versionFor(bytes, 'one')])]), '0.2.40', store).list();
    const site = siteOf([appOf('one', [versionFor(bytes, 'one'), versionFor(bytes, 'one', '2.0.0')]), appOf('two', [versionFor(bytes, 'two')])]);
    const market = marketOf(site, '0.2.40', store);
    const listing = await market.list();
    expect(listing.extensions.map((entry) => entry.manifest.id)).toEqual(['one']);
    expect(listing.fetchedAt).toBe(new Date(clock).toISOString());
    expect((await market.updatesFor([{ id: 'one', version: '1.0.0' }])).updates).toEqual({});
    expect(site.indexReads).toBe(0);
  });

  it('refresh():去取一趟、说结果 —— 变了 / 没变 / 没取到(手上那份照旧,带它的时刻);每一趟都报给 onRefreshed', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('one', [versionFor(bytes, 'one')])]);
    const market = marketOf(site);
    const heard: MarketRefreshed[] = [];
    market.onRefreshed((refreshed) => heard.push(refreshed));
    const first = new Date(clock).toISOString();
    expect(await market.refresh()).toEqual({ outcome: 'changed', fetchedAt: first });
    clock += 60_000;
    expect(await market.refresh()).toEqual({ outcome: 'unchanged', fetchedAt: new Date(clock).toISOString() });
    site.down = true;
    clock += 60_000;
    const failed = await market.refresh();
    expect(failed).toMatchObject({ outcome: 'failed', fetchedAt: new Date(clock - 60_000).toISOString() });
    expect((await market.list()).extensions.map((entry) => entry.manifest.id)).toEqual(['one']);
    expect(heard.map((refreshed) => refreshed.outcome)).toEqual(['changed', 'unchanged', 'failed']);
  });

  it('同一时刻只有一趟:打开页面那一趟、第一次清单、更新检查一起来,只取一次', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('one', [versionFor(bytes, 'one')])]);
    const market = marketOf(site);
    await Promise.all([market.refresh(), market.list(), market.updatesFor([{ id: 'one', version: '1.0.0' }])]);
    expect(site.indexReads).toBe(1);
  });

  // A/B 10-08: 0.1.3 withdrawn in the index — the installed row said so, the market page still offered 0.1.3: the two read
  // the index at different moments. Now both read the one in hand, and a refresh replaces it for both at once.
  it('被撤回:手上那份里还没撤,后台取回来已经撤了 —— 清单和更新检查同一刻一起变(之前一起旧,之后一起新)', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const v2 = versionFor(bytes, 'ext', '0.1.2');
    const v3 = versionFor(bytes, 'ext', '0.1.3');
    const site = siteOf([appOf('ext', [v2, v3])]);
    const market = marketOf(site);
    const installed = [{ id: 'ext', version: '0.1.3' }];
    expect((await market.list()).extensions[0]!.version).toBe('0.1.3');
    site.index = { apps: [appOf('ext', [v2, { ...v3, yanked: { reason: 'bad' } }])] };
    expect((await market.list()).extensions[0]!.version).toBe('0.1.3');
    expect((await market.updatesFor(installed)).yanked).toEqual({});
    expect((await market.refresh()).outcome).toBe('changed');
    expect((await market.list()).extensions[0]!.version).toBe('0.1.2');
    expect((await market.updatesFor(installed)).yanked).toEqual({ ext: { reason: 'bad', installable: '0.1.2' } });
  });

  // 10-14:咕咕开着时上架的 App,app_install 说市场上没有 —— 它读的是市场页上次取的那份。
  it('entry(id, true) 越过手上那份现取(安装),取到的替换手上那份、照样报;不带的(详情)照旧读手上那份', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('one', [versionFor(bytes, 'one')])]);
    const market = marketOf(site);
    await market.list();
    const heard: MarketRefreshed[] = [];
    market.onRefreshed((refreshed) => heard.push(refreshed));
    site.index = { apps: [appOf('one', [versionFor(bytes, 'one')]), appOf('new', [versionFor(bytes, 'new')])] };
    expect(await market.entry('new')).toBeNull();
    expect(site.indexReads).toBe(1);
    expect((await market.entry('new', true))?.manifest.id).toBe('new');
    expect(site.indexReads).toBe(2);
    expect(heard.map((refreshed) => refreshed.outcome)).toEqual(['changed']);
    expect((await market.list()).total).toBe(2);
  });
});

describe('CloudExtensionMarket.history / readme / updatesFor', () => {
  it('历史最新在前,撤回的带原因,每一版带兼容结论', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('ext', [
        versionFor(bytes, 'ext', '1.0.0'),
        versionFor(bytes, 'ext', '1.1.0', { yanked: { reason: '会丢数据' } }),
        versionFor(bytes, 'ext', '1.2.0', { minAppVersion: '9.9.9' }),
      ]),
    ]);
    const history = await marketOf(site).history('ext');
    expect(history.map((entry) => entry.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(history[1]!.yanked).toEqual({ reason: '会丢数据' });
    expect(history[0]!.compat).toMatchObject({ reason: 'needs-newer-app' });
    expect(history[2]!.compat).toBeNull();
  });

  it('README 从下载站那一版的文件取;没写就 null', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf(
      [appOf('ext', [versionFor(bytes, 'ext', '1.0.0', { readme: 'media/ext/readme-1.md' }), versionFor(bytes, 'ext', '1.1.0')])],
      { 'media/ext/readme-1.md': '# hello' }
    );
    const market = marketOf(site);
    expect(await market.readme('ext', '1.0.0')).toBe('# hello');
    expect(await market.readme('ext', '1.1.0')).toBeNull();
  });

  it('装着的:有新版 / 这版被撤回 / 扩展已弃用,各归各;本地比市场新的不提示', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([
      appOf('ext-a', [versionFor(bytes, 'ext-a', '1.0.0'), versionFor(bytes, 'ext-a', '2.0.0')]),
      appOf('ext-b', [versionFor(bytes, 'ext-b', '1.0.0', { yanked: { reason: 'bad' } }), versionFor(bytes, 'ext-b', '2.0.0')]),
      appOf('ext-c', [versionFor(bytes, 'ext-c', '1.0.0')], { deprecated: { note: null, replacedBy: 'ext-a' } }),
      appOf('ext-d', [versionFor(bytes, 'ext-d', '1.0.0')]),
    ]);
    const summary = await marketOf(site).updatesFor([
      { id: 'ext-a', version: '1.0.0' },
      { id: 'ext-b', version: '1.0.0' },
      { id: 'ext-c', version: '1.0.0' },
      { id: 'ext-d', version: '3.0.0' },
      { id: 'not-on-market', version: '1.0.0' },
    ]);
    expect(summary.updates).toEqual({ 'ext-a': { version: '2.0.0', releaseNotes: 'notes for 2.0.0' } });
    expect(summary.yanked).toEqual({ 'ext-b': { reason: 'bad', installable: '2.0.0' } });
    expect(summary.deprecated).toEqual({ 'ext-c': { note: null, replacedBy: 'ext-a' } });
  });

  it('更新检查读和市场页同一份目录:❌ 自己再去取一份(两份可能不是同一刻)', async () => {
    const bytes = await zipOf({ 'manifest.json': '{}' });
    const site = siteOf([appOf('ext', [versionFor(bytes, 'ext')])]);
    const market = marketOf(site);
    await market.list();
    await market.updatesFor([{ id: 'ext', version: '1.0.0' }]);
    expect(site.indexReads).toBe(1);
  });

  it('什么都没装就什么都不查', async () => {
    const site = siteOf([]);
    const summary = await marketOf(site).updatesFor([]);
    expect(summary.updates).toEqual({});
    expect(site.indexReads).toBe(0);
  });
});

describe('CloudExtensionMarket.materialize', () => {
  it('指纹对得上就解包成一个目录,并报进度', async () => {
    const bytes = await zipOf({
      'manifest.json': JSON.stringify(manifestOf('ok-ext')),
      'index.html': '<!doctype html>',
      'assets/app.js': 'console.log(1)',
    });
    const version = versionFor(bytes, 'ok-ext');
    const market = marketOf(siteOf([appOf('ok-ext', [version])], { [version.bundle]: bytes }));
    const progress: [number, number][] = [];
    const { sourceDir: dir } = await market.materialize('ok-ext', '1.0.0', (received, total) => progress.push([received, total]));
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'assets/app.js'), 'utf8')).toBe('console.log(1)');
    expect(progress.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
  });

  it('指纹对不上就一个字节都不落地', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('tampered')) });
    const version = versionFor(bytes, 'tampered', '1.0.0', { sha256: 'f'.repeat(64) });
    const market = marketOf(siteOf([appOf('tampered', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('tampered', '1.0.0')).rejects.toThrow(/fingerprint mismatch/);
    // 目录一个都没留下 —— 「装之前才发现」与「根本没落地」是两种事故等级。
    expect(fs.existsSync(path.join(root, 'staging'))).toBe(false);
  });

  it('字节数对不上就拒绝', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('short')) });
    const version = versionFor(bytes, 'short', '1.0.0', { bytes: bytes.byteLength + 1 });
    const market = marketOf(siteOf([appOf('short', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('short', '1.0.0')).rejects.toThrow(/size mismatch/);
  });

  it('撤回的版本装不了,并说出原因', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('pulled')) });
    const version = versionFor(bytes, 'pulled', '1.0.0', { yanked: { reason: '会把工作区写坏' } });
    const market = marketOf(siteOf([appOf('pulled', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('pulled', '1.0.0')).rejects.toThrow(/withdrawn: 会把工作区写坏/);
  });

  it('这台咕咕太老的版本装不了(界面灰掉之外的第二道)', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('needs-new')) });
    const version = versionFor(bytes, 'needs-new', '1.0.0', { minAppVersion: '9.9.9' });
    const market = marketOf(siteOf([appOf('needs-new', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('needs-new', '1.0.0')).rejects.toThrow(/needs gugu 9\.9\.9/);
  });

  it('历史里的旧版本可以装(它不是最新版,但在市场上)', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('old-ok', '1.0.0')) });
    const v1 = versionFor(bytes, 'old-ok', '1.0.0');
    const v2 = versionFor(await zipOf({ 'manifest.json': '{}' }), 'old-ok', '2.0.0');
    const market = marketOf(siteOf([appOf('old-ok', [v1, v2])], { [v1.bundle]: bytes }));
    const prepared = await market.materialize('old-ok', '1.0.0');
    expect(fs.existsSync(path.join(prepared.sourceDir, 'manifest.json'))).toBe(true);
    // The sheet speaks of the version unpacked, not the market's current one (复核 96 R3).
    expect(prepared).toMatchObject({ source: v1.source, releaseNotes: 'notes for 1.0.0' });
  });

  it('装的时候目录现取:缓存里还在、市场上已经下架的那一版装不了', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('gone-now')) });
    const version = versionFor(bytes, 'gone-now');
    const site = siteOf([appOf('gone-now', [version])], { [version.bundle]: bytes });
    const market = marketOf(site);
    await market.list();
    site.index = { apps: [] };
    await expect(market.materialize('gone-now', '1.0.0')).rejects.toThrow(/no longer available/);
  });

  it('归档里带 `../` 的条目,解不到目标目录外面去', async () => {
    // 实测(2026-09-10,jszip 3.10.1):`loadAsync` 自己会把 `../escaped.js` 规范化成
    // `escaped.js` —— 也就是说 `..` 这一族到不了我们的判据面前。这条用例钉的是**结果**
    // (东西没跑到外面去),而不是「谁拦下的」;判据本身由 bundleEntryRejection 那组直接测。
    // ⚠️ 换掉解压库就要重跑这条:规范化是那个库的行为,不是我们的保证。
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifestOf('zip-slip')), { date: new Date(0) });
    zip.file('escaped.js', 'pwned', { date: new Date(0) });
    const smuggled = zip.files['escaped.js']!;
    delete zip.files['escaped.js'];
    smuggled.name = '../escaped.js';
    zip.files['../escaped.js'] = smuggled;
    const bytes = new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }));
    const version = versionFor(bytes, 'zip-slip');
    const market = marketOf(siteOf([appOf('zip-slip', [version])], { [version.bundle]: bytes }));
    const { sourceDir: dir } = await market.materialize('zip-slip', '1.0.0');
    const staging = path.join(root, 'staging');
    expect(fs.existsSync(path.join(dir, 'escaped.js'))).toBe(true);
    expect(fs.existsSync(path.join(staging, 'escaped.js'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'escaped.js'))).toBe(false);
  });

  it('包里的 manifest 与市场上那张卡片必须是同一版', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('swapped', '2.0.0')) });
    const version = versionFor(bytes, 'swapped', '1.0.0');
    const market = marketOf(siteOf([appOf('swapped', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('swapped', '1.0.0')).rejects.toThrow(/not swapped@1\.0\.0/);
  });

  it('已经不在市场上的版本装不了', async () => {
    await expect(marketOf(siteOf([])).materialize('gone', '1.0.0')).rejects.toThrow(/no longer available/);
  });

  it('上一次留下的解包目录会被扫掉', async () => {
    const staging = path.join(root, 'staging');
    const leftover = path.join(staging, '.market-old-deadbeef');
    fs.mkdirSync(leftover, { recursive: true });
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('fresh')) });
    const version = versionFor(bytes, 'fresh');
    await marketOf(siteOf([appOf('fresh', [version])], { [version.bundle]: bytes })).materialize('fresh', '1.0.0');
    expect(fs.existsSync(leftover)).toBe(false);
  });

  it('留着等人点头的一份:下一次 materialize 扫不到它,held 按这一版的 sha256 认回它(不再下),用完删掉', async () => {
    const one = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('first')) });
    const two = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('second')) });
    const v1 = versionFor(one, 'first');
    const v2 = versionFor(two, 'second');
    const site = siteOf([appOf('first', [v1]), appOf('second', [v2])], { [v1.bundle]: one, [v2.bundle]: two });
    const market = marketOf(site);
    const kept = market.hold(await market.materialize('first', '1.0.0'));
    expect(kept.sourceDir).toBe(path.join(root, 'held', v1.sha256));
    // 首启那一页连着备好几份:备第二份时 staging 被扫,留着的第一份还在。
    await market.materialize('second', '1.0.0');
    expect(fs.existsSync(path.join(kept.sourceDir, 'manifest.json'))).toBe(true);
    const again = await market.held('first', '1.0.0');
    expect(again).toMatchObject({ sourceDir: kept.sourceDir, sha256: v1.sha256, source: v1.source, releaseNotes: 'notes for 1.0.0' });
    expect(site.downloads).toBe(2);
    market.discard(again!);
    expect(await market.held('first', '1.0.0')).toBeNull();
    // 没留过的一版:没有就是没有,调用方照常下。
    expect(await market.held('second', '1.0.0')).toBeNull();
  });

  it('上一次运行留着、没等到点头的那几份,sweepHeld 扫掉', () => {
    const leftover = path.join(root, 'held', 'a'.repeat(64));
    fs.mkdirSync(leftover, { recursive: true });
    fs.writeFileSync(path.join(leftover, 'manifest.json'), '{}');
    marketOf(siteOf([])).sweepHeld();
    expect(fs.existsSync(path.join(root, 'held'))).toBe(false);
  });

  it('解包字节是边解边数的:一个能胀过上限的文件在胀到上限那一刻就停', async () => {
    // 65 MiB 的零压成几十 KB 的 zip;老写法要把它整个解到内存再数,新写法数到 64 MiB 就停。
    const bomb = new Uint8Array(65 * 1024 * 1024);
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('bomb')), 'big.bin': bomb });
    const version = versionFor(bytes, 'bomb');
    const market = marketOf(siteOf([appOf('bomb', [version])], { [version.bundle]: bytes }));
    await expect(market.materialize('bomb', '1.0.0')).rejects.toThrow(/unpacks to more than/);
    expect(fs.existsSync(path.join(root, 'staging'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'staging'))).toHaveLength(0);
  }, 60_000);
});

// Two installs at once (161 10-16: the first-run set goes in in the background while the person installs another): the
// second's sweep of leftovers leaves the copy the first unpacked and is installing.
describe('two unpacked at once', () => {
  it('the second does not sweep away the copy the first is installing; each goes when it is done with', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('ok-ext')), 'index.html': '<!doctype html>' });
    const market = marketOf(siteOf([appOf('ok-ext', [versionFor(bytes, 'ok-ext')])], { 'bundles/ok-ext/1.0.0.zip': bytes }));
    const first = await market.materialize('ok-ext', '1.0.0');
    const second = await market.materialize('ok-ext', '1.0.0');
    expect(fs.existsSync(path.join(first.sourceDir, 'manifest.json')), 'the first copy is still there for its install').toBe(true);
    expect(fs.existsSync(path.join(second.sourceDir, 'manifest.json'))).toBe(true);
    market.discard(first);
    market.discard(second);
    expect(fs.readdirSync(path.join(root, 'staging'))).toEqual([]);
  });

  it('control: what an earlier run left (nobody here is using it) is still swept', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(manifestOf('ok-ext')), 'index.html': '<!doctype html>' });
    const leftover = path.join(root, 'staging', '.market-ok-ext-left');
    fs.mkdirSync(leftover, { recursive: true });
    const market = marketOf(siteOf([appOf('ok-ext', [versionFor(bytes, 'ok-ext')])], { 'bundles/ok-ext/1.0.0.zip': bytes }));
    const copy = await market.materialize('ok-ext', '1.0.0');
    expect(fs.existsSync(leftover)).toBe(false);
    market.discard(copy);
  });
});
