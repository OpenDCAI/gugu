import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadTo } from './cli-tool-installer';

// 国内云上拉 GitHub 只有几十 KB/s(2026-10-28 在阿里云上实测 25 KB/s):下载只按「多久没进新字节」判卡住,
// ❌ 按总时长判 —— 从前整段 5 分钟一到就中止,14.7 MB 的飞书在云上永远下不完。
let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function stream(): { body: ReadableStream<Uint8Array>; push(bytes: number[]): void; end(): void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { body, push: (bytes) => controller.enqueue(new Uint8Array(bytes)), end: () => controller.close() };
}

it('finishes a slow download that keeps moving for longer than the stall window', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gugu-cli-stall-'));
  const source = stream();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body)));
  const file = path.join(dir, 'tool.tgz');
  const done = downloadTo('https://example.test/tool.tgz', file, 'sha256', 'hex', () => undefined, 80);
  // 一共 ~300 ms,远超 80 ms 的卡住窗口,但每 30 ms 都有新字节。
  for (let i = 0; i < 10; i += 1) {
    source.push([i]);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  source.end();
  await expect(done).resolves.toMatch(/^[0-9a-f]{64}$/);
  expect([...await readFile(file)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

it('fails loudly as stalled when no new bytes arrive within the window', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gugu-cli-stall-'));
  const source = stream();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(source.body)));
  const done = downloadTo('https://example.test/tool.tgz', path.join(dir, 'tool.tgz'), 'sha256', 'hex', () => undefined, 80);
  source.push([1, 2, 3]);
  await expect(done).rejects.toThrow('Download of tool.tgz stalled: no data for 0 s.');
});

it('treats a server that never answers as stalled too', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gugu-cli-stall-'));
  vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  })));
  await expect(downloadTo('https://example.test/tool.tgz', path.join(dir, 'tool.tgz'), 'sha256', 'hex', () => undefined, 50))
    .rejects.toThrow(/stalled/);
});
