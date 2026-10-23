import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { AcpTranscriptParser } from '../../acp/reducer/parser';
import { decodeClaudeRecord } from './claude-jsonl';
import { createOpencodeSqliteSource } from './opencode-sqlite';
import type { RecordEntry } from '../contract';

it.each([false, true])('#6020 Claude history preserves image results (with text: %s)', (mixed) => {
  const content = [
    ...(mixed ? [{ type: 'text', text: 'RESULT_TEXT' }] : []),
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGE_PAYLOAD' } },
  ];
  const entries = decodeClaudeRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'image', content }] } }, 'record');
  const parser = new AcpTranscriptParser({ sessionId: 'claude' });
  parser.push({ sessionUpdate: 'tool_call', toolCallId: 'image', title: 'screenshot', rawInput: { tab: 1 } });
  for (const entry of entries) if (entry.event) parser.pushEvent(entry.event);
  const item = parser.activeTurn?.items[0];
  // 148 10-14: the picture has its own channel now — an image block the card draws (`images`), as the live ACP stream
  // has it — instead of the whole result dumped as JSON text so that the picture was not hidden.
  expect(item).toMatchObject({ images: [{ mimeType: 'image/png', data: 'IMAGE_PAYLOAD' }] });
  expect(item).not.toHaveProperty('rawOutput');
  if (mixed) expect(item).toHaveProperty('outputText', 'RESULT_TEXT');
  else expect(item).not.toHaveProperty('outputText');
});

it('#6020 a Claude result with a block that is neither text nor a picture stays disclosed whole; its picture is drawn too', () => {
  const content = [
    { type: 'text', text: 'RESULT_TEXT' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'IMAGE_PAYLOAD' } },
    { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'DOC' } },
  ];
  const entries = decodeClaudeRecord({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'doc', content }] } }, 'record');
  const parser = new AcpTranscriptParser({ sessionId: 'claude' });
  parser.push({ sessionUpdate: 'tool_call', toolCallId: 'doc', title: 'read', rawInput: {} });
  for (const entry of entries) if (entry.event) parser.pushEvent(entry.event);
  expect(parser.activeTurn?.items[0]).toMatchObject({
    rawOutput: JSON.stringify(content, null, 2),
    outputText: JSON.stringify(content, null, 2),
    images: [{ mimeType: 'image/png', data: 'IMAGE_PAYLOAD' }],
  });
});

it('#6020 OpenCode observes late arguments, errors and attachments through SQLite polling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gugu-payload-6020-'));
  const dbPath = join(dir, 'opencode.db');
  const writer = new Database(dbPath);
  writer.exec(`CREATE TABLE session (id text PRIMARY KEY, title text, time_created integer, time_updated integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text, time_created integer, time_updated integer, data text);
    CREATE TABLE part (id text PRIMARY KEY, message_id text, session_id text, time_created integer, time_updated integer, data text);`);
  writer.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('session', 'payload', 1, 1);
  writer.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('message', 'session', 1, 1, JSON.stringify({ role: 'assistant' }));
  const data = (state: object) => JSON.stringify({ type: 'tool', tool: 'lookup', callID: 'lookup', state });
  writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('part', 'message', 'session', 1, 1, data({ status: 'pending', input: {} }));
  // 轮询节拍走假时钟:每写一次库就推一个节拍,源在那一拍里同步读完,❌ 押 vi.waitFor 的 1s 期限。
  const POLL_INTERVAL_MS = 10;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const source = createOpencodeSqliteSource({ harness: 'opencode', providerSessionId: 'session', roots: [dbPath] }, { pollIntervalMs: POLL_INTERVAL_MS });
  const nextPoll = () => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  const entries: RecordEntry[] = [];
  const parser = new AcpTranscriptParser({ sessionId: 'opencode' });
  try {
    await source.start({ onEntries: (batch) => {
      entries.push(...batch);
      for (const entry of batch) if (entry.event) parser.pushEvent(entry.event);
    }, onReset: () => { throw new Error('unexpected reset'); } });
    const update = writer.prepare('UPDATE part SET data = ?, time_updated = ? WHERE id = ?');
    update.run(data({ status: 'running', input: { query: 'LATE_ARGUMENT' } }), 2, 'part');
    await nextPoll();
    expect(JSON.stringify(parser.activeTurn?.items)).toContain('LATE_ARGUMENT');
    update.run(data({ status: 'error', input: { query: 'LATE_ARGUMENT' }, error: 'FAILURE_REASON' }), 3, 'part');
    await nextPoll();
    expect(JSON.stringify(parser.activeTurn?.items)).toContain('FAILURE_REASON');
    const attachments = [{ type: 'file', url: 'data:image/png;base64,IMAGE_ATTACHMENT', mime: 'image/png' }];
    writer.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run('second', 'message', 'session', 4, 4,
      JSON.stringify({ type: 'tool', tool: 'screenshot', callID: 'screenshot', state: { status: 'completed', input: {}, output: 'CAPTION' } }));
    await nextPoll();
    expect(JSON.stringify(parser.activeTurn?.items)).toContain('CAPTION');
    update.run(JSON.stringify({ type: 'tool', tool: 'screenshot', callID: 'screenshot', state: { status: 'completed', input: {}, output: 'CAPTION', attachments } }), 5, 'second');
    await nextPoll();
    expect(JSON.stringify(parser.activeTurn?.items)).toContain('IMAGE_ATTACHMENT');
    const screenshot = parser.activeTurn?.items.find((item) => 'toolCallId' in item && item.toolCallId === 'screenshot');
    expect(screenshot).toHaveProperty('outputText', JSON.stringify({ output: 'CAPTION', attachments }, null, 2));
    expect(JSON.stringify(parser.activeTurn?.items)).toContain('CAPTION');
    const replay = new AcpTranscriptParser({ sessionId: 'opencode' });
    for (const entry of entries) if (entry.event) replay.pushEvent(entry.event);
    expect(JSON.stringify(replay.activeTurn)).toContain('LATE_ARGUMENT');
    expect(JSON.stringify(replay.activeTurn)).toContain('FAILURE_REASON');
    expect(JSON.stringify(replay.activeTurn)).toContain('IMAGE_ATTACHMENT');
  } finally {
    vi.useRealTimers();
    await source.stop();
    writer.close();
    await rm(dir, { recursive: true, force: true });
  }
});
