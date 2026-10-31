import { describe, expect, it } from 'vitest';
import { textFilePatch } from '@gugu/session-core/lib';
import { fileChangeSummary } from './file-change-summary';
import type { ChatDiff, ChatItem } from '../model';
const turn = (items: ChatItem[]) => ({ items });
const diff = (id: string, path: string, before: string | null, after: string): ChatDiff =>
  ({ kind: 'diff', id, patches: [textFilePatch(path, before, after)], status: 'done' });

describe('settled patch totals', () => {
  it('counts observed patches without inventing a full-file chain', () => {
    const items = Array.from({ length: 5 }, (_, i) => diff(`d${i}`, `/r/file-${i}.txt`, null, 'one'));
    const result = fileChangeSummary([turn([...items, diff('next', '/r/file-0.txt', 'one', 'two')])], 't1');
    expect(result?.files).toHaveLength(5);
    expect(result).toMatchObject({ adds: 6, dels: 1 });
    expect(result?.files[0]).toMatchObject({ adds: 2, dels: 1 });
    expect(result?.files[0]!.diffs).toHaveLength(2);
  });
  it('keeps path identity, patch identity and independent regions', () => {
    const first = diff('a', '/a/index.ts', 'old', 'new');
    const next = diff('c', '/a/index.ts', 'other', 'next');
    const result = fileChangeSummary([turn([first, diff('b', '/b/index.ts', null, 'b'), next])], 't1');
    expect(result?.files.map(file => file.path)).toEqual(['/a/index.ts', '/b/index.ts']);
    expect(result?.files[0]).toMatchObject({ adds: 2, dels: 2 });
    expect(result?.files[0]!.diffs[0]!.patches[0]).toBe(first.patches[0]);
    expect(result?.files[0]!.diffs[1]!.patches[0]).toBe(next.patches[0]);
  });
  it('does not claim proposed, failed, running or child edits completed', () => {
    const base = diff('a', '/a', null, 'x');
    expect(fileChangeSummary([turn([
      { ...base, status: 'running' }, { ...base, status: 'error' },
      { ...base, awaitingPermission: true }, { ...base, parentId: 'child' } as ChatItem,
      { ...base, parentToolCallId: 'child' } as ChatItem,
    ])], 't1')).toBeNull();
  });
  it('counts a multi-file block once and leaves unallocated per-file totals unknown', () => {
    const first = diff('a', '/a', 'A', 'B');
    const patch = first.patches[0]!;
    first.patches = [{ ...patch, changes: [...patch.changes, { operation: 'move', oldPath: '/old', path: '/new' }] }];
    const result = fileChangeSummary([turn([first])], 't');
    expect(result).toMatchObject({ adds: 1, dels: 1 });
    expect(result?.files).toMatchObject([{ path: '/a', adds: null, dels: null }, { path: '/new', adds: null, dels: null }]);
  });
});
