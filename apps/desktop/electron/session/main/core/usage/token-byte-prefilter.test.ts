import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readLogFileDelta } from './token-log-file';
import { claudeTokenReader } from './token-readers/claude';
import { codexTokenReader } from './token-readers/codex';
import { createUsagePrefilter } from './token-readers/usage-prefilter';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const file = (data: string | Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-byte-test-')); dirs.push(dir);
  const path = join(dir, 'synthetic.jsonl'); writeFileSync(path, data); return path;
};
const usage = (id: string) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-07T00:00:00Z', requestId: id,
  message: { id, model: 'synthetic', usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 25, cache_creation_input_tokens: 4 } } });
it('uses identical ASCII markers and conservatively accepts cross-line marker matches', () => {
  for (const reader of [claudeTokenReader, codexTokenReader]) for (const text of [usage('a'), '{"type":"token_count"}', '{"type":"session_meta"}', '{"type":"turn_context"}', 'no usage', '{"text":"\\"type\\":\\"assistant\\""}']) {
    expect(reader.mayCarryUsageBytes?.(Buffer.from(text))).toBe(reader.mayCarryUsage(text));
  }
  expect(claudeTokenReader.mayCarryUsageBytes?.(Buffer.from('"type":"assistant"\n"usage":{\n'))).toBe(true);
  expect(() => createUsagePrefilter([['中文']])).toThrow('ASCII');
});
it('skips multi-megabyte irrelevant complete blocks before string filtering and retains partial line offsets', async () => {
  const irrelevant = JSON.stringify({ type: 'user', text: 'x'.repeat(2_600_000) }) + '\n';
  const path = file(irrelevant + usage('tail').slice(0, 40));
  const filter = vi.fn(claudeTokenReader.mayCarryUsage);
  const reader = { ...claudeTokenReader, mayCarryUsage: filter };
  const first = await readLogFileDelta(path, reader);
  expect(first.offset).toBe(Buffer.byteLength(irrelevant)); expect(first.entries).toEqual([]); expect(filter).not.toHaveBeenCalled();
  appendFileSync(path, usage('tail').slice(40) + '\n');
  const next = await readLogFileDelta(path, reader, first);
  expect(next.entries).toHaveLength(1); expect(next.entries[0]).toMatchObject({ input: 12, cacheRead: 25, cacheWrite: 4 });
});
it('matches the original string path across chunk markers, UTF-8 and malformed bytes', async () => {
  const data = Buffer.concat([Buffer.from(JSON.stringify({ type: 'user', text: '字'.repeat(360_000) }) + '\n'), Buffer.from(usage('a') + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(usage('b') + '\n')]);
  const path = file(data);
  expect(await readLogFileDelta(path, claudeTokenReader)).toEqual(await readLogFileDelta(path, { ...claudeTokenReader, mayCarryUsageBytes: undefined }));
});
it('preserves the legacy reader path when no byte prefilter exists', async () => {
  const path = file(usage('one') + '\n'); const filter = vi.fn(claudeTokenReader.mayCarryUsage);
  const parsed = await readLogFileDelta(path, { ...claudeTokenReader, mayCarryUsageBytes: undefined, mayCarryUsage: filter });
  expect(parsed.entries).toHaveLength(1); expect(filter).toHaveBeenCalledTimes(1);
});
