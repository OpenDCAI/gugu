import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cliInstallProgress, ensureCliTool, isCliToolInstalled } from './cli-tool-installer';

const originalHome = process.env.GUGU_HOME;
let home: string | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.GUGU_HOME;
  else process.env.GUGU_HOME = originalHome;
  if (home) await rm(home, { recursive: true, force: true });
});

it('reports received bytes while a real response stream is incomplete, and never marks a bad archive installed', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'gugu-cli-progress-'));
  process.env.GUGU_HOME = home;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === 'https://example.test/tool.tgz') return new Response(body, { headers: { 'content-length': '8' } });
    if (url.startsWith('https://registry.npmmirror.com/')) return Response.json({ dist: { tarball: 'https://example.test/tool.tgz' } });
    return new Response('unavailable', { status: 503 });
  }));
  const installing = ensureCliTool('dws');
  const rejected = expect(installing).rejects.toThrow('integrity mismatch');
  controller.enqueue(new Uint8Array([1, 2, 3, 4]));
  await vi.waitFor(() => expect(cliInstallProgress('dws')).toEqual({ phase: 'download', receivedBytes: 4, totalBytes: 8, file: 'tool.tgz' }));
  expect(isCliToolInstalled('dws')).toBe(false);
  controller.enqueue(new Uint8Array([5, 6, 7, 8]));
  controller.close();
  await rejected;
  expect(cliInstallProgress('dws')).toBeUndefined();
  expect(isCliToolInstalled('dws')).toBe(false);
});
