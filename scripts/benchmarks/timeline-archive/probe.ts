import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { produceWithPatches } from '../../../packages/session-wire/src/live/state/immer-setup';
import { createSessionTimeline, type TimelineArchive } from '../../../packages/session-core/src/session-record/timeline';
import { createClaudeJsonlSource } from '../../../packages/session-core/src/session-record/sources/claude-jsonl';
import { createCodexJsonlSource } from '../../../packages/session-core/src/session-record/sources/codex-jsonl';
import { TailReader } from '../../../packages/session-core/src/session-record/sources/tail-reader';
import { loadTimelineArchive, saveTimelineArchive } from '../../../apps/desktop/electron/session/main/core/session-timeline/archive-store';

produceWithPatches({}, () => {});
let fullReads = 0;
const readFromStart = TailReader.prototype.readFromStart;
TailReader.prototype.readFromStart = function (...args) {
  fullReads++;
  return readFromStart.apply(this, args);
};
const dir = process.argv[2];
const id = '00000000-0000-4000-8000-000000000001';
const timestamp = '2026-01-01T00:00:00.000Z';
const sampleText = 'Synthetic transcript: ASCII, 中文, 😀, escaped \\"\n'.repeat(24);
type Harness = 'claude' | 'codex';

async function fixture(harness: Harness, bytes: number) {
  const root = join(dir, `${harness}-${bytes}`);
  await mkdir(root, { recursive: true });
  const rows: string[] = [];
  let length = 0;
  let parentUuid: string | null = null;
  const add = (record: object) => { const line = JSON.stringify(record) + '\n'; rows.push(line); length += Buffer.byteLength(line); };
  for (let i = 0; length < bytes - 16 * 1024; i++) {
    if (harness === 'claude') {
      for (const role of ['user', 'assistant'] as const) {
        const uuid = `record-${i}-${role}`;
        add({ uuid, parentUuid, sessionId: id, timestamp, type: role,
          message: { id: uuid, role, content: [{ type: 'text', text: sampleText }], ...(role === 'assistant' ? { stop_reason: 'end_turn' } : {}) } });
        parentUuid = uuid;
      }
    } else {
      add({ timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: `turn-${i}` } });
      for (const role of ['user', 'assistant'] as const) add({ timestamp, type: 'response_item', payload: {
        type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: sampleText }],
      } });
      add({ timestamp, type: 'event_msg', payload: { type: 'task_complete', turn_id: `turn-${i}` } });
    }
  }
  // Pad with a valid ignored metadata row to hit the source cap exactly.
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'fixture_padding', text: '' }) + '\n');
  add({ type: 'fixture_padding', text: 'x'.repeat(bytes - length - overhead) });
  const file = join(root, harness === 'claude' ? `${id}.jsonl` : `rollout-${id}.jsonl`);
  await writeFile(file, rows.join(''));
  assert.equal((await stat(file)).size, bytes);
  return root;
}

async function open(harness: Harness, root: string, sessionId: string, archive?: TimelineArchive | null) {
  const locator = { harness, providerSessionId: id, roots: [root] };
  const source = harness === 'claude' ? createClaudeJsonlSource(locator, { pollIntervalMs: 1_000_000 })
    : createCodexJsonlSource(locator, { pollIntervalMs: 1_000_000 });
  return createSessionTimeline(source, { sessionId, archive });
}

export { fixture, open, loadTimelineArchive, saveTimelineArchive };
export const fullReadCount = () => fullReads;
