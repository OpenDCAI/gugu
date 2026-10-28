import { describe, expect, it } from 'vitest';
import { rankPaletteMatches } from './palette-rank';

const names = (items: { name: string }[]) => items.map((item) => item.name);
const rank = (items: { name: string }[], query: string, recallOnly = false) =>
  names(rankPaletteMatches(items, query, (item) => [item.name], { recallOnly }));

describe('quick switcher ranking', () => {
  it('puts exact, then prefix, then contains, then pinyin ahead of list order', () => {
    const items = [{ name: '设计评审 gugu' }, { name: '咕咕内测群' }, { name: 'gugu dev' }, { name: 'gugu' }];
    expect(rank(items, 'gugu')).toEqual(['gugu', 'gugu dev', '设计评审 gugu', '咕咕内测群']);
    expect(rank([{ name: 'design review' }, { name: '咕咕内测群' }], 'gg')).toEqual(['咕咕内测群']);
  });

  it('keeps the source order (recent first) among equal matches and for an empty query', () => {
    const items = [{ name: 'alpha one' }, { name: 'alpha two' }];
    expect(rank(items, 'alpha')).toEqual(['alpha one', 'alpha two']);
    expect(rank(items, '  ')).toEqual(['alpha one', 'alpha two']);
  });

  it('only reorders already-recalled results (index hits on branch or issue keep their place at the end)', () => {
    const items = [{ name: 'fix login' }, { name: 'perf work' }, { name: 'perf' }];
    expect(rank(items, 'perf', true)).toEqual(['perf', 'perf work', 'fix login']);
  });
});
