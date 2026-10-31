import { describe, expect, it } from 'vitest';
import { marketHome } from './market-home';

type Entry = Parameters<typeof marketHome>[0][number];
const entry = (id: string, first: string, extra: Partial<Entry> = {}): Entry => ({
  manifest: { id, name: id, version: '1.0.0', apiVersion: 24, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id }] } },
  version: '1.0.0', publishedAt: first, firstPublishedAt: first,
  deprecated: null, compat: null, featured: false, firstRun: false, ...extra,
});
const ids = (entries: readonly Entry[]) => entries.map((item) => item.manifest.id);

describe('marketHome', () => {
  it('shows each of twelve Apps once on home while keeping complete New and Popular pages', () => {
    const entries = [
      entry('browser-use', '2026-10-16T11:41:18Z', { firstRun: true }),
      entry('computer-use', '2026-10-16T11:41:20Z'),
      entry('day-calendar', '2026-10-14T03:03:16Z'),
      entry('forum', '2026-10-21T01:49:21Z'),
      entry('kanban', '2026-10-19T06:18:32Z'),
      entry('office', '2026-10-16T01:01:31Z', { firstRun: true }),
      entry('omnisearch', '2026-10-16T01:01:35Z', { firstRun: true }),
      entry('paper-club', '2026-10-19T01:43:08Z', { featured: true }),
      entry('radar', '2026-10-09T08:19:48Z', { featured: true }),
      entry('spexcode', '2026-10-18T18:54:50Z', { featured: true }),
      entry('studio', '2026-10-22T09:48:52Z'),
      entry('turtle-soup', '2026-10-19T01:32:59Z'),
    ];
    const home = marketHome(entries, new Map([['kanban', 12], ['forum', 4], ['studio', 3], ['computer-use', 2]]));
    expect(ids(home.featured)).toEqual(['kanban', 'forum', 'studio']);
    expect(ids(home.remaining)).toEqual(['paper-club', 'turtle-soup', 'spexcode', 'computer-use', 'browser-use', 'omnisearch', 'office', 'day-calendar', 'radar']);
    expect(ids([...home.featured, ...home.remaining]).sort()).toEqual(ids(entries).sort());
    expect(ids(home.newest)).toEqual(['studio', 'forum', 'kanban', ...ids(home.remaining)]);
    expect(ids(home.popular!)).toEqual(['kanban', 'forum', 'studio', 'computer-use']);
  });

  it('keeps small catalogs short and distinguishes a failed ranking from no qualifying installs', () => {
    expect(marketHome([], new Map())).toEqual({ featured: [], remaining: [], newest: [], popular: [] });
    const only = entry('only', '2026-10-01', { featured: true });
    expect(marketHome([only], null)).toEqual({ featured: [only], remaining: [], newest: [only], popular: null });
    const second = entry('second', '2026-10-02');
    const two = marketHome([only, second], new Map([['second', 1]]));
    expect(ids(two.featured)).toEqual(['second', 'only']);
    expect(two.remaining).toEqual([]);
    expect(ids(two.popular!)).toEqual(['second']);
  });

  it('excludes unavailable and retired Apps from recommendations, not from the complete New list', () => {
    const entries = [
      entry('retired', '2026-10-04', { featured: true, deprecated: { note: null, replacedBy: null } }),
      entry('blocked', '2026-10-03', { featured: true, compat: { reason: 'needs-newer-app', minAppVersion: '9.0.0' } }),
      entry('default', '2026-10-02', { firstRun: true, featured: true }),
      entry('editor', '2026-10-01', { featured: true }),
    ];
    const home = marketHome(entries, new Map(entries.map((item) => [item.manifest.id, 1])));
    expect(ids(home.featured)).toEqual(['editor']);
    expect(ids(home.remaining)).toEqual(['default']);
    expect(ids(home.popular!)).toEqual(['default', 'editor']);
    expect(ids(home.newest)).toEqual(['retired', 'blocked', 'default', 'editor']);
  });

  it('orders by first publication rather than updates, with name and id resolving ties and no six-App cap', () => {
    const entries = Array.from({ length: 14 }, (_, i) => entry(`app-${String(i).padStart(2, '0')}`, '2026-10-01'));
    entries[0] = { ...entries[0]!, publishedAt: '2026-10-24' };
    entries[13] = { ...entries[13]!, firstPublishedAt: '2026-10-02' };
    const home = marketHome(entries, new Map());
    expect(ids(home.newest)).toEqual(['app-13', ...ids(entries.slice(0, 13))]);
    expect(home.remaining).toEqual(home.newest);
    expect(entries[0]!.manifest.id).toBe('app-00');
  });

  it('resolves score ties by id and fills only the remaining featured positions in catalog order', () => {
    const entries = [entry('z-editor', '2026-10-01', { featured: true }), entry('b-hot', '2026-10-02'), entry('a-hot', '2026-10-03'), entry('other-editor', '2026-10-04', { featured: true })];
    const home = marketHome(entries, new Map([['b-hot', 2], ['a-hot', 2]]));
    expect(ids(home.featured)).toEqual(['a-hot', 'b-hot', 'z-editor']);
    expect(ids(home.remaining)).toEqual(['other-editor']);
  });

  it('reports a missing first publication date instead of sorting by the latest update', () => {
    const broken = entry('broken', '2026-10-24', { firstPublishedAt: undefined as unknown as string });
    expect(() => marketHome([broken], new Map())).toThrow('broken has no first publication date');
  });
});
