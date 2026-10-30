import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import feeds from '../../../../updateFeeds.json';

const h = vi.hoisted(() => ({ fetch: vi.fn(), userData: '' }));

vi.mock('electron', () => ({ app: { getPath: () => h.userData, isPackaged: true }, net: { fetch: h.fetch } }));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: async () => '9.9.9' }));

/**
 * 读下载站走 Chromium 的网络栈(net.fetch)和它的 HTTP 缓存:README、截图、包都是内容哈希路径、immutable,
 * 重启后从磁盘答(owner 10-30「既然曾经缓存过,为什么又要失效又要重新读取」)。Node 的 fetch 没有 HTTP 缓存,每次都上网。
 */
describe('the market reads the download site through Chromium', () => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'market-root-'));
  afterAll(() => fs.rmSync(h.userData, { recursive: true, force: true }));

  it('the README of a featured App is asked of net.fetch', async () => {
    const readme = 'media/pomo/readme-abc.md';
    const index = {
      apps: [{ id: 'pomo', deprecated: null, versions: [{
        version: '1.0.0',
        manifest: { apiVersion: 3, id: 'pomo', name: 'Pomo', version: '1.0.0', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Pomo' }] } },
        apiVersion: 3, minAppVersion: '0.1.0', releaseNotes: '', publishedAt: '2026-10-01T00:00:00Z', sha256: 'a'.repeat(64), bytes: 1,
        bundle: 'bundles/pomo/1.0.0.zip', icon: null, readme, source: { repo: 'OpenDCAI/gugu', path: 'extensions/pomo', commit: 'a'.repeat(40) }, yanked: null,
      }] }],
    };
    h.fetch.mockImplementation(async (url: string) =>
      url.endsWith('index.json') ? new Response(JSON.stringify(index)) : url.endsWith(readme) ? new Response('# Pomo') : new Response(null, { status: 404 }));
    const { cloudExtensionMarket } = await import('./market-catalog-root');
    expect(await cloudExtensionMarket().readme('pomo', '1.0.0')).toBe('# Pomo');
    expect(h.fetch.mock.calls.map(([url]) => String(url))).toContain(new URL(readme, feeds.market).toString());
  });
});
