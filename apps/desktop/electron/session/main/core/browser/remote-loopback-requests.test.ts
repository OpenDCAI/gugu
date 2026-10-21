import { describe, expect, it, vi } from 'vitest';
import { decideLoopbackRequest, loopbackPortOf, type LoopbackDeps } from './remote-loopback-requests';

function deps(overrides: Partial<LoopbackDeps> = {}) {
  const open = vi.fn(async ({ remotePort }: { remotePort: number }) => remotePort);
  const base: LoopbackDeps = {
    binding: (browserId) => (browserId === 'remote-tab' ? { deviceId: 'd1', sessionId: 'c1' } : null),
    browserIdFor: (id) => (id === 1 ? 'remote-tab' : id === 2 ? 'local-tab' : null),
    remoteForLocal: () => null,
    open,
    status: () => null,
    ...overrides,
  };
  return { deps: base, open };
}

describe('localhost requests made by a page in a remote browser tab', () => {
  it('reads the port, defaults included', () => {
    expect(loopbackPortOf('http://localhost:8000/api')).toBe(8000);
    expect(loopbackPortOf('ws://127.0.0.1:5173/hmr')).toBe(5173);
    expect(loopbackPortOf('https://[::1]/')).toBe(443);
    expect(loopbackPortOf('https://example.com/')).toBeNull();
  });

  it('forwards the other port (frontend 5173 calling backend 8000) and always lands on 127.0.0.1, never plain localhost', async () => {
    const { deps: d, open } = deps();
    // localhost could resolve to ::1 and hit an unrelated IPv6-only server on this computer.
    await expect(decideLoopbackRequest({ url: 'http://localhost:8000/api', webContentsId: 1 }, d)).resolves.toEqual({
      redirect: 'http://127.0.0.1:8000/api',
    });
    await expect(decideLoopbackRequest({ url: 'ws://[::1]:8000/hmr', webContentsId: 1 }, d)).resolves.toEqual({
      redirect: 'ws://127.0.0.1:8000/hmr',
    });
    await expect(decideLoopbackRequest({ url: 'http://127.0.0.1:8000/api', webContentsId: 1 }, d)).resolves.toEqual({ pass: true });
    expect(open).toHaveBeenCalledWith({ deviceId: 'd1', sessionId: 'c1', remotePort: 8000, holder: 'remote-tab' });
  });

  it("rewrites to this computer's port when the same number was taken here", async () => {
    const { deps: d } = deps({ open: async () => 51000 });
    await expect(decideLoopbackRequest({ url: 'http://127.0.0.1:8000/api?q=1', webContentsId: 1 }, d)).resolves.toEqual({
      redirect: 'http://127.0.0.1:51000/api?q=1',
    });
  });

  it("passes the page's own (already forwarded) port without asking again", async () => {
    const { deps: d, open } = deps({
      remoteForLocal: (_d, local) => (local === 51000 ? 5173 : null),
      status: () => ({ phase: 'ready', localPort: 51000 }),
    });
    await expect(decideLoopbackRequest({ url: 'http://127.0.0.1:51000/', webContentsId: 1 }, d)).resolves.toEqual({ pass: true });
    await expect(decideLoopbackRequest({ url: 'http://localhost:51000/x', webContentsId: 1 }, d)).resolves.toEqual({
      redirect: 'http://127.0.0.1:51000/x',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('re-forwards a local port whose forward has died, by its remote port', async () => {
    const { deps: d, open } = deps({ remoteForLocal: () => 5173, status: () => ({ phase: 'closed', localPort: null }) });
    await decideLoopbackRequest({ url: 'http://localhost:51000/', webContentsId: 1 }, d);
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ remotePort: 5173 }));
  });

  it('blocks instead of hitting this computer when the port cannot be forwarded', async () => {
    const { deps: d } = deps({
      open: async () => {
        throw new Error('refused');
      },
    });
    await expect(decideLoopbackRequest({ url: 'http://localhost:9/', webContentsId: 1 }, d)).resolves.toEqual({ cancel: true });
  });

  it('never touches local tabs or requests without a tab', async () => {
    const { deps: d, open } = deps();
    await expect(decideLoopbackRequest({ url: 'http://localhost:8000/', webContentsId: 2 }, d)).resolves.toEqual({ pass: true });
    await expect(decideLoopbackRequest({ url: 'http://localhost:8000/' }, d)).resolves.toEqual({ pass: true });
    expect(open).not.toHaveBeenCalled();
  });
});
