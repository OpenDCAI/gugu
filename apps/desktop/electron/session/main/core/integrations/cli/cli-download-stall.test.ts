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

// 重复点「连接」、或几台设备同时每 20 秒问一次 `cliToolPrepare`:同一个工具只能有一份下载在跑。
it('starts one download for a tool however many callers ask while it installs', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'gugu-cli-dedupe-'));
  const originalHome = process.env.GUGU_HOME;
  process.env.GUGU_HOME = dir;
  try {
    const { ensureCliTool, isCliToolInstalling } = await import('./cli-tool-installer');
    const source = stream();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith('https://registry.npmmirror.com/')
        ? Response.json({ dist: { tarball: 'https://example.test/tool.tgz' } })
        : new Response(source.body));
    vi.stubGlobal('fetch', fetch);
    const installs = [ensureCliTool('dws'), ensureCliTool('dws'), ensureCliTool('dws')];
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(new Set(installs).size).toBe(1);
    expect(isCliToolInstalling('dws')).toBe(true);
    // 第四个人晚到,照样接上同一份。
    expect(ensureCliTool('dws')).toBe(installs[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    source.push([1]);
    source.end();
    await Promise.all(installs.map((install) => install.catch(() => undefined)));
    expect(isCliToolInstalling('dws')).toBe(false);
  } finally {
    if (originalHome === undefined) delete process.env.GUGU_HOME;
    else process.env.GUGU_HOME = originalHome;
  }
});
