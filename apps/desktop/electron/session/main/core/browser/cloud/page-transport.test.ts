import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpEvent, CdpHub } from './cdp-hub';
import { createCloudPageTransport, PAGE_SESSION } from './page-transport';
import { chromeArgs, findChrome, linkCachesOut, openDisplay, parseDevToolsActivePort, PROFILE_CACHES } from './chrome';

/** 一个只记命令、能手动推事件的 hub。 */
function fakeHub() {
  const sent: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const listeners = new Set<(event: CdpEvent) => void>();
  const hub = {
    closed: false,
    send: async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
      sent.push({ method, params, sessionId });
      if (method === 'Target.attachToTarget') return { sessionId: 'S-page' };
      if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'T1', type: 'page', title: 'p', url: 'https://a.test/' } };
      if (method === 'Browser.getVersion') return { product: 'Chrome/141.0.0.0', protocolVersion: '1.3' };
      return { ok: method };
    },
    onEvent: (listener: (event: CdpEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose: () => () => {},
  };
  return { hub: hub as unknown as CdpHub, sent, push: (event: CdpEvent) => listeners.forEach((l) => l(event)) };
}

async function collect(transport: { onmessage?: (m: object) => void }) {
  const got: Array<Record<string, unknown>> = [];
  transport.onmessage = (m) => got.push(m as Record<string, unknown>);
  return got;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('#7199 cloud page transport (one tab per session)', () => {
  it('浏览器级的由这里应答、只报这一页;页面上的命令带上那条 flatten 会话转给 Chrome', async () => {
    const { hub, sent } = fakeHub();
    const transport = await createCloudPageTransport(hub, 'T1');
    const got = await collect(transport);
    transport.send({ id: 1, method: 'Browser.getVersion' });
    transport.send({ id: 2, method: 'Target.setAutoAttach', params: { autoAttach: true } });
    transport.send({ id: 3, method: 'Target.createTarget', params: { url: 'about:blank' } });
    transport.send({ id: 4, method: 'Page.navigate', params: { url: 'https://b.test/' }, sessionId: PAGE_SESSION });
    transport.send({ id: 5, method: 'Target.getTargets', sessionId: PAGE_SESSION });
    await tick();
    await tick();
    expect(got.find((m) => m.id === 1)?.result).toMatchObject({ product: 'Chrome/141.0.0.0' });
    expect(got.find((m) => m.method === 'Target.attachedToTarget')?.params).toMatchObject({ sessionId: PAGE_SESSION, targetInfo: { targetId: 'T1', type: 'page' } });
    expect(String((got.find((m) => m.id === 3)?.error as { message: string }).message)).toMatch(/not available/);
    expect(sent.find((c) => c.method === 'Page.navigate')).toEqual({ method: 'Page.navigate', params: { url: 'https://b.test/' }, sessionId: 'S-page' });
    expect(String((got.find((m) => m.id === 5)?.error as { message: string }).message)).toMatch(/not available/);
  });

  it('那一页上的事件改报成 Playwright 认的会话名;别的页签的事件不转', async () => {
    const { hub, push } = fakeHub();
    const transport = await createCloudPageTransport(hub, 'T1');
    const got = await collect(transport);
    push({ method: 'Page.loadEventFired', params: {}, sessionId: 'S-page' });
    push({ method: 'Page.loadEventFired', params: {}, sessionId: 'S-other' });
    push({ method: 'Target.attachedToTarget', params: { sessionId: 'S-child' }, sessionId: 'S-page' });
    push({ method: 'Runtime.consoleAPICalled', params: {}, sessionId: 'S-child' });
    await tick();
    expect(got.map((m) => [m.method, m.sessionId])).toEqual([
      ['Page.loadEventFired', PAGE_SESSION],
      ['Target.attachedToTarget', PAGE_SESSION],
      ['Runtime.consoleAPICalled', 'S-child'],
    ]);
  });

  it('页签被关 = transport 收场;停止之后的命令照实拒', async () => {
    const { hub, push } = fakeHub();
    let stopped = false;
    const transport = await createCloudPageTransport(hub, 'T1', { refuse: () => (stopped ? 'stopped by the person' : null) });
    const got = await collect(transport);
    stopped = true;
    transport.send({ id: 9, method: 'Input.dispatchMouseEvent', params: {}, sessionId: PAGE_SESSION });
    await tick();
    expect((got.find((m) => m.id === 9)?.error as { message: string }).message).toBe('stopped by the person');
    let closedWith = '';
    transport.onclose = (reason) => (closedWith = reason ?? '');
    push({ method: 'Target.targetDestroyed', params: { targetId: 'T1' } });
    expect(closedWith).toMatch(/closed/);
  });
});

describe('#7199 cloud Chrome launcher', () => {
  const fs = (files: string[], dirs: Record<string, string[]> = {}) =>
    ({
      existsSync: (p: string) => files.includes(String(p)),
      statSync: (p: string) => {
        if (!files.includes(String(p))) throw new Error('ENOENT');
        return { isFile: () => true };
      },
      readdirSync: (p: string) => {
        const entries = dirs[String(p)];
        if (!entries) throw new Error('ENOENT');
        return entries;
      },
    }) as never;

  it('找 Chrome:指定了就只认它(给错 = 没有),否则按 PATH 找', () => {
    expect(findChrome({ PATH: '/usr/local/bin:/usr/bin' }, fs(['/usr/bin/google-chrome']))).toBe('/usr/bin/google-chrome');
    expect(findChrome({ PATH: '/usr/bin', GUGU_CLOUD_BROWSER_CHROME: '/opt/x/chrome' }, fs(['/usr/bin/google-chrome']))).toBeNull();
    expect(findChrome({ PATH: '/usr/bin' }, fs([]))).toBeNull();
  });

  it('开有界面的:DISPLAY 优先;否则自己的 Xvfb,❌ 借 /tmp/.X11-unix 里别人的;连 Xvfb 都没有 = 无头', async () => {
    expect((await openDisplay({ DISPLAY: ':0' }, fs([]))).display).toBe(':0');
    // Control (the parent commit 583b4dfc): with no DISPLAY it took the first socket there, here another lane's :1.
    expect((await openDisplay({ PATH: '/usr/bin' }, fs([], { '/tmp/.X11-unix': ['X3', 'X1'] }))).display).toBeNull();
    expect(chromeArgs({ userDataDir: '/p', cacheDir: '/c', headless: true, root: false })).toContain('--headless=new');
    expect(chromeArgs({ userDataDir: '/p', cacheDir: '/c', headless: false, root: true })).toEqual(expect.arrayContaining(['--no-sandbox', '--remote-debugging-address=127.0.0.1']));
    expect(chromeArgs({ userDataDir: '/p', cacheDir: '/c', headless: false, root: false })).not.toContain('--headless=new');
  });

  it.skipIf(!nodeFs.existsSync('/usr/bin/Xvfb'))('no DISPLAY: its own Xvfb on a free display, gone when stopped', async () => {
    const own = await openDisplay({ PATH: '/usr/bin' });
    expect(own.display).toMatch(/^:\d+$/);
    const socket = `/tmp/.X11-unix/X${own.display!.slice(1)}`;
    expect(nodeFs.existsSync(socket)).toBe(true);
    own.stop();
    await vi.waitFor(() => expect(nodeFs.existsSync(socket)).toBe(false));
  });

  it('读 DevToolsActivePort', () => {
    expect(parseDevToolsActivePort('41234\n/devtools/browser/abc\n')).toEqual({ port: 41234, path: '/devtools/browser/abc' });
    expect(parseDevToolsActivePort('nope')).toBeNull();
  });

  it('资料夹里的缓存换成软链指进缓存目录:老资料夹的实体目录删掉,再启动不动它,醒来缓存目录空了就重建', () => {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'gugu-cache-out-'));
    const profile = path.join(root, 'home', 'data', 'cloud-browser', 'profile');
    const cache = path.join(root, 'home', '.cache', 'gugu-cloud-browser', 'default');
    try {
      nodeFs.mkdirSync(path.join(profile, 'Default', 'Code Cache', 'js'), { recursive: true });
      nodeFs.writeFileSync(path.join(profile, 'Default', 'Code Cache', 'js', 'index'), 'old');
      nodeFs.writeFileSync(path.join(profile, 'Default', 'Cookies'), 'keep');

      linkCachesOut(profile, cache);
      for (const rel of PROFILE_CACHES) {
        const link = path.join(profile, rel);
        expect(nodeFs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(nodeFs.readlinkSync(link)).toBe(path.join(cache, 'profile', rel));
        expect(nodeFs.statSync(link).isDirectory()).toBe(true);
      }
      expect(nodeFs.readdirSync(path.join(profile, 'Default', 'Code Cache'))).toEqual([]);
      expect(nodeFs.readFileSync(path.join(profile, 'Default', 'Cookies'), 'utf8')).toBe('keep');

      // 再启动:Chrome 写进去的缓存留着
      nodeFs.writeFileSync(path.join(profile, 'Default', 'GPUCache', 'data_0'), 'gpu');
      linkCachesOut(profile, cache);
      expect(nodeFs.readFileSync(path.join(cache, 'profile', 'Default', 'GPUCache', 'data_0'), 'utf8')).toBe('gpu');

      // 存档不收 ~/.cache:醒来软链悬空,启动前补上目标
      nodeFs.rmSync(cache, { recursive: true, force: true });
      linkCachesOut(profile, cache);
      for (const rel of PROFILE_CACHES) expect(nodeFs.statSync(path.join(profile, rel)).isDirectory()).toBe(true);

      // 家目录换了位置(存档解到别处):旧软链指向不存在的地方,换成新的
      const moved = path.join(root, 'moved-cache');
      linkCachesOut(profile, moved);
      expect(nodeFs.readlinkSync(path.join(profile, 'Default', 'Code Cache'))).toBe(path.join(moved, 'profile', 'Default', 'Code Cache'));
      expect(nodeFs.existsSync(path.join(moved, 'profile', 'GrShaderCache'))).toBe(true);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
