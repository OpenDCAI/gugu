import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCodexJsonlSource } from './codex-jsonl';
import { AcpTranscriptParser } from '../../acp/reducer/parser';
import { filePatchFixtures } from '../../acp/transport/file-patches.fixture';
import { projectToolContent } from '../../acp/models/tool-payload';
import type { RecordEntry } from '../contract';

it.each(filePatchFixtures.slice(0, 4))('replays native Codex $name with the live patch codec', async ({ block }) => {
  const root = await mkdtemp(join(tmpdir(), 'codex-file-record-'));
  const id = 'file-fixture';
  const file = join(root, `rollout-fixture-${id}.jsonl`);
  const change = block.changes[0]!;
  const patch = block.patch;
  if (!patch) throw new Error('Expected a rendered patch fixture');
  const oldPath = 'oldPath' in change ? change.oldPath : null;
  // Actual native item_completed/FileChange envelope, not a parsed apply_patch tool string.
  const native = { type: 'event_msg', payload: { type: 'item_completed', item: {
    type: 'FileChange', id: 'native-file-id', status: 'completed', changes: {
      [oldPath ?? change.path]: { type: 'update', move_path: oldPath ? change.path : null, unified_diff: patch.text },
    },
  } } };
  const entries: RecordEntry[] = [];
  const source = createCodexJsonlSource({ harness: 'codex', providerSessionId: id, roots: [root] });
  try {
    await writeFile(file, JSON.stringify(native) + '\n');
    await source.start({ onEntries: batch => entries.push(...batch), onReset: () => {} });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.event).toMatchObject({ kind: 'tool_update', toolCallId: 'native-file-id', status: 'completed' });
    const parser = new AcpTranscriptParser({ sessionId: 'native-file' });
    for (const entry of entries) if (entry.event) parser.pushEvent(entry.event, 1);
    const item = parser.activeTurn!.items[0]!;
    expect(item).toMatchObject({ kind: 'patch-tool-call', toolCallId: 'native-file-id', status: 'done' });
    if (!('contentBlocks' in item)) throw new Error('Missing native file entity');
    const expected = { type: 'diff', scope: 'file', changes: [oldPath ? { operation: 'move', oldPath, path: change.path } : { operation: 'modify', path: change.path }], patch };
    expect(projectToolContent(item.contentBlocks ?? []).diffs).toEqual([expected]);
    const restored = new AcpTranscriptParser({ sessionId: 'native-file' });
    restored.restoreState(JSON.parse(JSON.stringify(parser.snapshotState())));
    expect(restored.activeTurn).toEqual(parser.activeTurn);
  } finally {
    source.stop();
    await rm(root, { recursive: true, force: true });
  }
});
