import { describe, expect, it } from 'vitest';
import { computeDiffRows, countChanges, type DiffRow } from './diff-lines';

const sides = (rows: DiffRow[]) => ({
  old: rows.filter((r) => r.type !== 'add').map((r) => r.text).join('\n'),
  new: rows.filter((r) => r.type !== 'remove').map((r) => r.text).join('\n'),
});

describe('computeDiffRows', () => {
  it('keeps shared lines and marks the one replaced line', () => {
    expect(computeDiffRows('a\nb\nc', 'a\nx\nc')).toEqual([
      { type: 'context', text: 'a', oldIdx: 0, newIdx: 0 },
      { type: 'remove', text: 'b', oldIdx: 1 },
      { type: 'add', text: 'x', newIdx: 1 },
      { type: 'context', text: 'c', oldIdx: 2, newIdx: 2 },
    ]);
  });

  it('finds a shortest script that rebuilds both sides, including a whole-file rewrite', () => {
    const cases: [string, string][] = [
      ['a\nb\nc\na\nb\nb\na', 'c\nb\na\nb\na\nc'],
      ['x\nx\nx', 'x'],
      ['', 'a\nb'],
      [Array.from({ length: 4000 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 4000 }, (_, i) => `new ${i}`).join('\n')],
    ];
    for (const [oldText, newText] of cases) {
      const rows = computeDiffRows(oldText, newText);
      expect(sides(rows)).toEqual({ old: oldText, new: newText });
    }
    // Myers' paper example: the shortest script has 5 edits.
    const { adds, dels } = countChanges(computeDiffRows('a\nb\nc\na\nb\nb\na', 'c\nb\na\nb\na\nc'));
    expect(adds + dels).toBe(5);
    expect(countChanges(computeDiffRows(cases[3]![0], cases[3]![1]))).toEqual({ adds: 4000, dels: 4000 });
  });
});
