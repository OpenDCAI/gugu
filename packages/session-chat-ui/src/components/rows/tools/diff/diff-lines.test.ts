import { describe, expect, it } from 'vitest';
import { filePatchFixtures } from '../../../../../../session-core/src/acp/transport/file-patches.fixture';
import type { SessionPatch } from '@gugu/session-core/acp';
import { parsePatchRows, patchStats } from './diff-lines';

describe('raw patch presentation', () => {
  it('keeps separated hunks and their absolute positions', () => {
    const patch = { ...filePatchFixtures[0].block, scope: 'file' } as SessionPatch;
    const rows = parsePatchRows(patch);
    expect(rows.filter(row => row.type === 'hunk').map(row => row.text)).toEqual(['@@ -2,2 +2,2 @@', '@@ -90 +90,2 @@']);
    expect(rows.filter(row => row.type === 'add').map(row => row.newIdx)).toEqual([2, 89, 90]);
    expect(rows.at(-1)?.text).toBe('\\ No newline at end of file');
    expect(patchStats(patch)).toEqual({ adds: 3, dels: 2 });
  });
  it('preserves CR characters and explicitly marks fragments', () => {
    const patch = { ...filePatchFixtures[3].block, scope: 'fragment' } as SessionPatch;
    const rows = parsePatchRows(patch);
    expect(rows.find(row => row.type === 'add')?.text).toBe('three\r');
    expect(rows.find(row => row.type === 'hunk')?.text.startsWith('… @@')).toBe(true);
  });
  it('does not invent textual counts for binary, absent or opaque patches', () => {
    for (const index of [2, 4, 5]) expect(patchStats({ ...filePatchFixtures[index]!.block, scope: 'file' } as SessionPatch)).toBeNull();
    const rename = { ...filePatchFixtures[1].block, scope: 'file' } as SessionPatch;
    expect(parsePatchRows(rename).every(row => row.type === 'meta')).toBe(true);
    expect(patchStats(rename)).toEqual({ adds: 0, dels: 0 });
  });
});
