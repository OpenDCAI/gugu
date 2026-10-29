// Protocol 13 compatibility (delete with protocol13FileChanges on the next protocol bump).
import { describe, expect, it } from 'vitest';
import { textFilePatch } from '../lib/text-diff';
import { FILE_PATCH_PROTOCOL, protocol13FileChanges } from './contract';

const base = { id: 't:tool:1', seq: 2, toolCallId: 'edit-1', title: 'Edit src/a.ts', status: 'done', locations: [{ path: '/w/src/a.ts' }] };

describe('protocol 13 file changes on the wire', () => {
  it('from a 13 host: each old file entity becomes the canonical patch entity, exactly', () => {
    const turn = { id: 't', items: [
      { ...base, kind: 'modify-file-tool-call', path: '/w/src/a.ts', oldText: 'one\n', newText: 'two\n' },
      { ...base, toolCallId: 'new-1', kind: 'create-file-tool-call', path: '/w/b.ts', content: 'b\n' },
      { ...base, toolCallId: 'del-1', kind: 'delete-file-tool-call', path: '/w/c.ts' },
    ] };
    const converted = protocol13FileChanges({ t: 'result', value: { turns: [turn] } }, 13, 'from-peer');
    expect(converted.value.turns[0]!.items).toEqual([
      { ...base, kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/src/a.ts', 'one\n', 'two\n')] },
      { ...base, toolCallId: 'new-1', kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/b.ts', null, 'b\n')] },
      { ...base, toolCallId: 'del-1', kind: 'patch-tool-call',
        contentBlocks: [{ type: 'diff', changes: [{ operation: 'delete', path: '/w/c.ts' }], scope: 'unknown' }] },
    ]);
  });

  it('to a 13 peer: a patch entity becomes a generic tool row with its title, locations and the raw patch text', () => {
    const patch = textFilePatch('/w/src/a.ts', 'one\n', 'two\n');
    const item = { ...base, kind: 'patch-tool-call', contentBlocks: [patch] };
    const converted = protocol13FileChanges({ t: 'event', data: { activeTurn: { items: [item] } } }, 13, 'to-peer');
    expect(converted.data.activeTurn.items[0]).toEqual({
      ...base, kind: 'unknown-tool-call', name: 'Edit src/a.ts', toolKind: 'edit', outputText: patch.patch!.text,
    });
  });

  it('between protocol 14 peers nothing is converted: the same value comes back', () => {
    const item = { ...base, kind: 'patch-tool-call', contentBlocks: [textFilePatch('/w/a', 'x', 'y')] };
    const message = { t: 'result', value: { turns: [{ id: 't', items: [item] }] } };
    expect(protocol13FileChanges(message, FILE_PATCH_PROTOCOL, 'to-peer')).toBe(message);
    expect(protocol13FileChanges(message, FILE_PATCH_PROTOCOL, 'from-peer')).toBe(message);
    // A 13 peer's message without file entities is returned unchanged too.
    const plain = { t: 'event', data: { usage: { contextUsed: 1 } } };
    expect(protocol13FileChanges(plain, 13, 'to-peer')).toBe(plain);
  });
});
