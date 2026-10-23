import { describe, expect, it } from 'vitest';
import { foldItem, type FoldEvent } from './item-fold';

const call: FoldEvent = {
  kind: 'tool_call',
  toolCallId: 'w1',
  title: 'Write plan.txt',
  toolKind: 'edit',
  status: 'pending',
  parentToolCallId: null,
  diffs: [],
  locations: [],
};

// ACP v2 omits a field an update does not change: the Claude bridge previews a file write with
// a tool_call_update that carries only the diff.
const preview: FoldEvent = {
  kind: 'tool_update',
  toolCallId: 'w1',
  diffs: [{ path: '/work/plan.txt', oldText: null, newText: 'hello' }],
};

const titles = (items: ReturnType<typeof foldItem>) => items.map((it) => ('title' in it ? it.title : undefined));

describe('a diff update without a title', () => {
  it('keeps the title of the call it updates', () => {
    const afterCall = foldItem([], call, 't1', 1);
    const afterPreview = foldItem(afterCall, preview, 't1', 2);
    expect(titles(afterPreview)).toEqual(['Write plan.txt']);
    // and a second untitled update keeps it on the diff row
    expect(titles(foldItem(afterPreview, preview, 't1', 3))).toEqual(['Write plan.txt']);
  });

  it('names a diff that arrives with nothing before it generically', () => {
    expect(titles(foldItem([], preview, 't1', 1))).toEqual(['Edit file']);
  });
});
