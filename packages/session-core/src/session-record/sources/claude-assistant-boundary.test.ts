import { appendFile, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { awaitPending } from '../../../../../tests/support/awaitFact';
import { createSessionTimeline } from '../timeline';
import { createClaudeJsonlSource } from './claude-jsonl';

// Captured adjacent Native rows: distinct record UUIDs, one assistant messageId,
// thinking then text, both end_turn. Only identifiers and prose are anonymized.
const parts = JSON.parse(await readFile(new URL('../__fixtures__/claude-assistant-parts.json', import.meta.url), 'utf8'));
const nextMessage = { ...parts[1], uuid: 'next-record', timestamp: '2026-10-25T01:40:13.000Z',
  message: { ...parts[1].message, id: 'different-native-message', content: [{ type: 'text', text: 'NEXT_MESSAGE' }] } };
const sessionId = 'e6bc8c24-11ce-461c-a668-57e129179292';
async function open(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'native-assistant-boundary-91-'));
  const file = join(root, sessionId + '.jsonl');
  await writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  const source = createClaudeJsonlSource({ harness: 'claude', providerSessionId: sessionId, roots: [root] }, { pollIntervalMs: 10 });
  const timeline = await createSessionTimeline(source, { sessionId: 'native-parts' });
  return { root, file, timeline, async dispose() { timeline.dispose(); await rm(file); await rmdir(root); } };
}
function expectGrouped(timeline: Awaited<ReturnType<typeof createSessionTimeline>>) {
  const turns = timeline.getSnapshot().turns;
  for (const turn of turns) console.info('actual_native_turn_row', JSON.stringify({ id: turn.id, endedAt: turn.endedAt,
    items: turn.items.map(item => ({ kind: item.kind, text: 'text' in item ? item.text : undefined })) }));
  expect(turns).toHaveLength(2);
  expect(turns[0].items).toMatchObject([{ kind: 'thinking', text: 'Recorded thought.' }, { kind: 'message', text: 'Recorded body.' }]);
  expect(turns[0].endedAt).toBe(Date.parse(parts[1].timestamp));
  expect(turns[1].items).toMatchObject([{ kind: 'message', text: 'NEXT_MESSAGE' }]);
}
it('keeps recorded thinking/body in one native message cycle and separates the next ID', async () => {
  const fixture = await open([...parts, nextMessage]);
  try { expectGrouped(fixture.timeline); } finally { await fixture.dispose(); }
});
it('continues the same native message from an archive before its later parts', async () => {
  const fixture = await open([parts[0]]);
  let reopened: typeof fixture.timeline | undefined;
  try {
    const archive = await fixture.timeline.archive?.();
    expect(archive).toBeTruthy();
    fixture.timeline.dispose();
    await appendFile(fixture.file, [parts[1], nextMessage].map(row => JSON.stringify(row)).join('\n') + '\n');
    reopened = await createSessionTimeline(createClaudeJsonlSource({ harness: 'claude', providerSessionId: sessionId,
      roots: [fixture.root] }), { sessionId: 'native-parts', archive });
    expectGrouped(reopened);
    expect(reopened.epoch).not.toBe(archive!.epoch);
  } finally { reopened?.dispose(); await fixture.dispose(); }
});
it('revises the same cycle when the body arrives in a later native tail read', async () => {
  const fixture = await open([parts[0]]);
  const delivered = Promise.withResolvers<void>();
  const before = fixture.timeline.getSnapshot();
  const unsub = fixture.timeline.subscribe(before.cursor, () => {
    if (fixture.timeline.getSnapshot().turns.some(turn => turn.items.some(item => item.kind === 'message' && item.text === 'NEXT_MESSAGE'))) delivered.resolve();
  });
  try {
    await appendFile(fixture.file, [parts[1], nextMessage].map(row => JSON.stringify(row)).join('\n') + '\n');
    await awaitPending('native body and next message delivered', delivered.promise);
    expectGrouped(fixture.timeline);
    expect(fixture.timeline.getSnapshot().turns[0].id).toBe(before.turns[0].id);
    expect(fixture.timeline.getSnapshot().cursor.epoch).toBe(before.cursor.epoch);
    expect(fixture.timeline.getSnapshot().cursor.seq).toBeGreaterThan(before.cursor.seq);
  } finally { unsub(); await fixture.dispose(); }
});
