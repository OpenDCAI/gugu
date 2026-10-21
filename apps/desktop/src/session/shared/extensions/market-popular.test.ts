import { describe, expect, it } from 'vitest';
import { popularOf } from './market';

// The market home's 「热门」 shelf: the same recent-install scores the featured row reads, best first; fewer than three
// scored Apps (today's usual case, see the PR) and there is no shelf at all.
type Entry = Parameters<typeof popularOf>[0][number];
const entry = (id: string, extra: Partial<Entry> = {}): Entry => ({ manifest: { id } as Entry['manifest'], deprecated: null, compat: null, ...extra });

describe('popularOf', () => {
  it('ranks the scored Apps best first (ties by id), leaving out unscored ones', () => {
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('e')];
    const scores = new Map([['c', 2], ['a', 5], ['d', 2], ['b', 1]]);
    expect(popularOf(entries, scores).map((item) => item.manifest.id)).toEqual(['a', 'c', 'd', 'b']);
  });

  it('is empty below three scored Apps, and without scores', () => {
    const entries = [entry('a'), entry('b'), entry('c')];
    expect(popularOf(entries, new Map([['a', 3], ['b', 1]]))).toEqual([]);
    expect(popularOf(entries, new Map())).toEqual([]);
  });

  it('leaves out Apps this machine cannot install and discontinued ones, before counting', () => {
    const entries = [entry('a'), entry('b', { deprecated: { note: 'gone', replacedBy: null } }), entry('c', { compat: { reason: 'needs-newer-app', minAppVersion: '9.0.0' } }), entry('d')];
    const scores = new Map([['a', 4], ['b', 3], ['c', 2], ['d', 1]]);
    expect(popularOf(entries, scores)).toEqual([]);
    expect(popularOf([...entries, entry('e')], new Map([...scores, ['e', 9]])).map((item) => item.manifest.id)).toEqual(['e', 'a', 'd']);
  });
});
