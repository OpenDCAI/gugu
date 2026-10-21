import { describe, expect, it } from 'vitest';
import { marketSnapshotSource, type MarketRefreshed, type MarketSnapshotStore } from './market-snapshot';

/**
 * 手上那份市场目录(owner 10-16「本地有缓存啊」):桌面主进程和手机共用这一份。判的是它答得快(有就给、从没取到过才等)、
 * 落下的那份认得出来(别的根、存坏了的不认)、同一时刻只取一趟、每一趟的结果都说清(变了 / 没变 / 没取到)。
 */

const INDEX_A = JSON.stringify({ apps: [] });
const INDEX_B = JSON.stringify({ apps: [{ id: 'one', deprecated: null, versions: [] }] });
const AT = Date.parse('2026-10-16T01:00:00.000Z');

function memoryStore(text: string | null = null): MarketSnapshotStore & { text: string | null; writes: number } {
  const store = {
    text,
    writes: 0,
    read: () => Promise.resolve(store.text),
    write: (next: string) => {
      store.text = next;
      store.writes += 1;
      return Promise.resolve();
    },
  };
  return store;
}

/** 下载站:每一次取都记下;`answer` 是下一次回什么(一段原文,或一个错)。 */
function siteOf(answer: string | Error) {
  const site = {
    answer,
    reads: 0,
    readIndex: () => {
      site.reads += 1;
      return site.answer instanceof Error ? Promise.reject(site.answer) : Promise.resolve(site.answer);
    },
  };
  return site;
}

const failures: string[] = [];

function sourceOf(site: ReturnType<typeof siteOf>, store = memoryStore(), scope = 'https://download.example/market/') {
  let clock = AT;
  failures.length = 0;
  const onFailure = (error: unknown) => failures.push(error instanceof Error ? error.message : String(error));
  const source = marketSnapshotSource({ readIndex: site.readIndex, store, scope, onFailure, now: () => clock });
  const heard: MarketRefreshed[] = [];
  source.onRefreshed((refreshed) => heard.push(refreshed));
  return { source, store, heard, tick: (ms: number) => (clock += ms) };
}

describe('marketSnapshotSource', () => {
  it('从没取到过:current() 等那一趟;之后 current() 不再去取', async () => {
    const site = siteOf(INDEX_B);
    const { source, heard } = sourceOf(site);
    expect((await source.current()).index.apps.map((app) => app.id)).toEqual(['one']);
    await source.current();
    expect(site.reads).toBe(1);
    expect(heard).toEqual([{ outcome: 'changed', fetchedAt: new Date(AT).toISOString() }]);
  });

  it('落下的那份:下一次(新的一个、同一处)current() 直接给它,❌ 去取;它的时刻是当时取到的时刻', async () => {
    const store = memoryStore();
    await sourceOf(siteOf(INDEX_B), store).source.current();
    const site = siteOf(new Error('offline'));
    const { source } = sourceOf(site, store);
    const snapshot = await source.current();
    expect(snapshot.index.apps.map((app) => app.id)).toEqual(['one']);
    expect(snapshot.fetchedAt).toBe(AT);
    expect(site.reads).toBe(0);
  });

  it('落下的那份是别的根的(开发形态指到本地测试市场),或者存坏了 —— 当没有,去取', async () => {
    const store = memoryStore();
    await sourceOf(siteOf(INDEX_B), store, 'https://other.example/market/').source.current();
    const site = siteOf(INDEX_A);
    expect((await sourceOf(site, store).source.current()).index.apps).toEqual([]);
    expect(site.reads).toBe(1);
    const broken = siteOf(INDEX_A);
    expect((await sourceOf(broken, memoryStore('{"v":1,"scope":"https://download.example/market/","fetchedAt":1,"text":"{"}')).source.current()).index.apps).toEqual([]);
    expect(broken.reads).toBe(1);
  });

  it('refresh():变了 / 没变 / 没取到;没取到时手上那份照旧,报它的时刻(原话给 onFailure)', async () => {
    const site = siteOf(INDEX_A);
    const { source, heard, tick } = sourceOf(site);
    expect(await source.refresh()).toEqual({ outcome: 'changed', fetchedAt: new Date(AT).toISOString() });
    tick(60_000);
    expect(await source.refresh()).toEqual({ outcome: 'unchanged', fetchedAt: new Date(AT + 60_000).toISOString() });
    site.answer = INDEX_B;
    tick(60_000);
    expect(await source.refresh()).toEqual({ outcome: 'changed', fetchedAt: new Date(AT + 120_000).toISOString() });
    site.answer = new Error('fetch failed');
    tick(60_000);
    expect(await source.refresh()).toEqual({ outcome: 'failed', fetchedAt: new Date(AT + 120_000).toISOString() });
    expect(failures).toEqual(['fetch failed']);
    expect((await source.current()).index.apps.map((app) => app.id)).toEqual(['one']);
    expect(heard.map((refreshed) => refreshed.outcome)).toEqual(['changed', 'unchanged', 'changed', 'failed']);
  });

  it('和落下的那份比「变没变」:重启后第一趟取回来一样,就是「没变」(界面什么都不重画)', async () => {
    const store = memoryStore();
    await sourceOf(siteOf(INDEX_B), store).source.current();
    expect((await sourceOf(siteOf(INDEX_B), store).source.refresh()).outcome).toBe('unchanged');
    expect((await sourceOf(siteOf(INDEX_A), store).source.refresh()).outcome).toBe('changed');
  });

  it('从没取到过又没取到:current() / fresh() 照实抛(界面说连不上),refresh() 报 failed、时刻 null', async () => {
    const { source, store } = sourceOf(siteOf(new Error('offline')));
    await expect(source.current()).rejects.toThrow('offline');
    await expect(source.fresh()).rejects.toThrow('offline');
    expect(await source.refresh()).toEqual({ outcome: 'failed', fetchedAt: null });
    expect(store.writes).toBe(0);
  });

  it('形状不对的目录照实抛,❌ 当成空市场;手上那份不动', async () => {
    const site = siteOf(INDEX_B);
    const { source } = sourceOf(site);
    await source.current();
    site.answer = JSON.stringify({ apps: 'nope' });
    await expect(source.fresh()).rejects.toThrow(/malformed/);
    expect((await source.current()).index.apps.map((app) => app.id)).toEqual(['one']);
  });

  it('同一时刻只有一趟:refresh、fresh、第一次 current 一起来,只取一次、只报一次', async () => {
    const site = siteOf(INDEX_B);
    const { source, heard } = sourceOf(site);
    const [refreshed] = await Promise.all([source.refresh(), source.fresh(), source.current()]);
    expect(refreshed.outcome).toBe('changed');
    expect(site.reads).toBe(1);
    expect(heard).toHaveLength(1);
    await source.refresh();
    expect(site.reads).toBe(2);
  });

  it('每一趟取到的都落下(下次启动先画它);退订之后不再听到', async () => {
    const site = siteOf(INDEX_B);
    const store = memoryStore();
    const source = marketSnapshotSource({ readIndex: site.readIndex, store, scope: 's', now: () => AT });
    const heard: string[] = [];
    const off = source.onRefreshed((refreshed) => heard.push(refreshed.outcome));
    await source.refresh();
    expect(JSON.parse(store.text!)).toEqual({ v: 1, scope: 's', fetchedAt: AT, text: INDEX_B });
    off();
    await source.refresh();
    expect(heard).toEqual(['changed']);
    expect(store.writes).toBe(2);
  });
});
