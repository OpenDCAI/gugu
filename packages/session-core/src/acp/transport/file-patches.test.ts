import { describe, expect, it } from 'vitest';
import { AcpTranscriptParser } from '../reducer/parser';
import { projectToolContent } from '../models/tool-payload';
import { decodeSessionUpdate } from './decode';
import { filePatchFixtures } from './file-patches.fixture';

function fixture() {
  const parser = new AcpTranscriptParser({ sessionId: 'patches' });
  let at = 100;
  const send = (update: Record<string, unknown>) => parser.pushEvent(decodeSessionUpdate(update as never), at++);
  const items = () => [...parser.history.flatMap(t => t.items), ...(parser.activeTurn?.items ?? [])];
  return { parser, send, items };
}

describe('canonical file patches', () => {
  it.each(filePatchFixtures)('preserves $name through decode, reduction and archive restoration', ({ block }) => {
    const { parser, send, items } = fixture();
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', name: 'apply_patch', kind: 'edit', status: 'completed', content: [block] });
    const item = items()[0];
    expect(item).toMatchObject({ kind: 'patch-tool-call', toolCallId: 'edit', status: 'done', contentBlocks: [{ ...block, scope: 'file' }] });
    expect(items()).toHaveLength(1);
    const restored = new AcpTranscriptParser({ sessionId: 'patches' });
    restored.restoreState(JSON.parse(JSON.stringify(parser.snapshotState())));
    expect(restored.activeTurn).toEqual(parser.activeTurn);
    expect(projectToolContent('contentBlocks' in item ? item.contentBlocks ?? [] : []).diffs).toEqual([{ ...block, scope: 'file' }]);
  });

  it('converts a v1 replacement only at ingress and marks its unknown full-file location', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call', toolCallId: 'v1', title: 'Edit', kind: 'edit', status: 'completed', content: [{ type: 'diff', path: 'C:\\work\\file.txt', oldText: 'one\r\ntwo', newText: 'one\r\nthree' }] });
    const item = items()[0];
    expect(item).toMatchObject({ kind: 'patch-tool-call', contentBlocks: [{ type: 'diff', changes: [{ operation: 'modify', path: 'C:\\work\\file.txt' }], scope: 'fragment', patch: { format: 'git_patch' } }] });
    expect(JSON.stringify(item)).not.toMatch(/oldText|newText/);
    const [patch] = projectToolContent('contentBlocks' in item ? item.contentBlocks ?? [] : []).diffs;
    expect(patch).toMatchObject({ patch: { text: expect.stringContaining('-two') } });
    expect(patch).toMatchObject({ patch: { text: expect.stringContaining('+three') } });
  });

  it('distinguishes an explicitly deleted file from an existing file becoming empty', () => {
    for (const kind of ['delete', 'edit']) {
      const { send, items } = fixture();
      send({ sessionUpdate: 'tool_call', toolCallId: 'v1', title: 'Edit', kind, status: 'completed', content: [{ type: 'diff', path: '/work/a', oldText: 'before', newText: '' }] });
      expect(items()[0]).toMatchObject({ contentBlocks: [{ changes: [{ operation: kind === 'delete' ? 'delete' : 'modify', path: '/work/a' }] }] });
    }
  });

  it('keeps one tool identity when patches replace, shorten, and clear', () => {
    const { send, items } = fixture();
    send({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit', kind: 'edit', status: 'in_progress' });
    const first = items()[0];
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: filePatchFixtures.slice(0, 2).map(f => f.block) });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id: first.id, seq: first.seq, kind: 'patch-tool-call' });
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: [filePatchFixtures[2].block] });
    const revised = items()[0];
    expect(projectToolContent('contentBlocks' in revised ? revised.contentBlocks ?? [] : []).diffs).toEqual([{ ...filePatchFixtures[2].block, scope: 'file' }]);
    send({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', content: [] });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ id: first.id, seq: first.seq, contentBlocks: [] });
  });
});
