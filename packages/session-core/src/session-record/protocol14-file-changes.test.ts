// Protocol 14 compatibility (delete with protocol14FileChanges on the next protocol bump).
import { describe, expect, it } from 'vitest';
import { textFilePatch } from '../lib/text-diff';
import { claudeFilePatch } from '../acp/transport/claude-file-patch';
import type { SessionPatch } from '../acp/session-protocol';
// The counter the 15 file card draws its +/- with.
import { patchStats } from '../../../session-chat-ui/src/components/rows/tools/diff/diff-lines';
import { FILE_PATCH_PROTOCOL, protocol14FileChanges } from './contract';

const base = { id: 't:tool:1', seq: 2, toolCallId: 'edit-1', title: 'Edit src/a.ts', status: 'done', locations: [{ path: '/w/src/a.ts' }] };

describe('protocol 14 file changes on the wire', () => {
  it('from a 14 host: each old file entity becomes the canonical patch entity, exactly', () => {
    const turn = { id: 't', items: [
      { ...base, kind: 'modify-file-tool-call', path: '/w/src/a.ts', oldText: 'one\n', newText: 'two\n' },
      { ...base, toolCallId: 'new-1', kind: 'create-file-tool-call', path: '/w/b.ts', content: 'b\n' },
      { ...base, toolCallId: 'del-1', kind: 'delete-file-tool-call', path: '/w/c.ts' },
    ] };
    const converted = protocol14FileChanges({ t: 'result', value: { turns: [turn] } }, 14, 'from-peer');
    expect(converted.value.turns[0]!.items).toEqual([
      { ...base, kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/src/a.ts', 'one\n', 'two\n')] },
      { ...base, toolCallId: 'new-1', kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/b.ts', null, 'b\n')] },
      { ...base, toolCallId: 'del-1', kind: 'patch-tool-call',
        contentBlocks: [{ type: 'diff', changes: [{ operation: 'delete', path: '/w/c.ts' }], scope: 'unknown' }] },
    ]);
  });

  it('from a 14 host: counts match 14↔14 for 14\'s newline-trimmed texts (rig817 Codex rollout 04-20-28 / 04-26-49)', () => {
    // 14's unifiedDiffTexts of Codex's real `@@ -2,4 +2,5 @@ beta -gamma +GAMMA-817 delta epsilon +zeta`: one trailing newline trimmed.
    const item = { ...base, kind: 'modify-file-tool-call', path: '/w/ab817.txt',
      oldText: 'beta\ngamma\ndelta\nepsilon', newText: 'beta\nGAMMA-817\ndelta\nepsilon\nzeta' };
    const [block] = (protocol14FileChanges(item, 14, 'from-peer') as unknown as { contentBlocks: SessionPatch[] }).contentBlocks;
    expect(patchStats(block!)).toEqual({ adds: 2, dels: 1 });
    const created = protocol14FileChanges({ ...item, kind: 'create-file-tool-call', content: 'alpha\nbeta' }, 14, 'from-peer');
    expect(patchStats((created as unknown as { contentBlocks: SessionPatch[] }).contentBlocks[0]!)).toEqual({ adds: 2, dels: 0 });
  });

  it('to a 14 peer: each changed file becomes 14\'s own file entity, its texts read from the hunks as 14 read them', () => {
    const modify = claudeFilePatch({ path: '/w/a.txt', hunks: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 4,
      lines: [' beta', '-gamma', '+GAMMA-817', ' delta', '+zeta'] }] });
    const add = textFilePatch('/w/new.txt', null, 'one\ntwo\n');
    const remove = textFilePatch('/w/old.txt', 'gone\n', null);
    const item = { ...base, kind: 'patch-tool-call', contentBlocks: [modify] };
    const one = protocol14FileChanges({ t: 'result', value: { items: [item] } }, 14, 'to-peer');
    // One file: the entity keeps its own id (live updates still address it).
    expect(one.value.items).toEqual([{ ...base, kind: 'modify-file-tool-call', path: '/w/a.txt',
      oldText: 'beta\ngamma\ndelta', newText: 'beta\nGAMMA-817\ndelta\nzeta' }]);
    const many = protocol14FileChanges({ items: [{ ...item, contentBlocks: [modify, add, remove] }] }, 14, 'to-peer');
    // Several files: one entity each, with 14's per-file ids, in the place of the one patch entity.
    expect(many.items).toEqual([
      { ...base, id: `${base.id}:/w/a.txt`, kind: 'modify-file-tool-call', path: '/w/a.txt', oldText: 'beta\ngamma\ndelta', newText: 'beta\nGAMMA-817\ndelta\nzeta' },
      { ...base, id: `${base.id}:/w/new.txt`, kind: 'create-file-tool-call', path: '/w/new.txt', content: 'one\ntwo' },
      { ...base, id: `${base.id}:/w/old.txt`, kind: 'delete-file-tool-call', path: '/w/old.txt' },
    ]);
  });

  it('to a 14 peer: a diff with only a path and no patch text becomes a generic row, with no invented text', () => {
    const item = { ...base, kind: 'patch-tool-call', contentBlocks: [{ type: 'diff', changes: [{ operation: 'modify', path: '/w/a.txt' }], scope: 'unknown' }] };
    expect(protocol14FileChanges(item, 14, 'to-peer')).toEqual({ ...base, kind: 'unknown-tool-call', name: 'Edit src/a.ts', toolKind: 'edit' });
  });

  it('between protocol 15 peers nothing is converted: the same value comes back', () => {
    const item = { ...base, kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/a', 'x', 'y')] };
    const message = { t: 'result', value: { turns: [{ id: 't', items: [item] }] } };
    expect(protocol14FileChanges(message, FILE_PATCH_PROTOCOL, 'to-peer')).toBe(message);
    expect(protocol14FileChanges(message, FILE_PATCH_PROTOCOL, 'from-peer')).toBe(message);
    // A 14 peer's message without file entities is returned unchanged too.
    const plain = { t: 'event', data: { usage: { contextUsed: 1 } } };
    expect(protocol14FileChanges(plain, 14, 'to-peer')).toBe(plain);
  });
});
