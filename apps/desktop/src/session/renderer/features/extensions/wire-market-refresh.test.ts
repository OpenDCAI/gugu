import { beforeEach, describe, expect, it, vi } from 'vitest';

// 本机的「有新版 / 被撤回」跟着手上那份市场目录走:启动时查一次、让主进程去取一趟;之后哪一趟取回来变了就再查 ——
// 和市场页同一份(10-08 那次两边读到不同时刻)。
const h = vi.hoisted(() => ({
  listeners: [] as { machine: string | null; name: string; cb: (data: unknown) => void }[],
  marketRefresh: vi.fn(async () => ({ success: true, data: { outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' } })),
  checkUpdates: vi.fn(async () => undefined),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: { marketRefresh: h.marketRefresh } },
  onMachineEvent: (machine: string | null, event: { name: string }, cb: (data: unknown) => void) => {
    h.listeners.push({ machine, name: event.name, cb });
    return () => undefined;
  },
}));
vi.mock('./installed-extensions-store', () => ({ installedExtensionsStore: { checkUpdates: h.checkUpdates } }));

const { wireMarketRefresh } = await import('./wire-market-refresh');

describe('wireMarketRefresh', () => {
  beforeEach(() => {
    h.listeners.length = 0;
    h.marketRefresh.mockClear();
    h.checkUpdates.mockClear();
  });

  it('启动:查一次(手上那份),让主进程去下载站取一趟;只听本机推的', () => {
    wireMarketRefresh();
    expect(h.checkUpdates).toHaveBeenCalledTimes(1);
    expect(h.marketRefresh).toHaveBeenCalledTimes(1);
    expect(h.listeners).toEqual([expect.objectContaining({ machine: null, name: 'extensions.market.refreshed' })]);
  });

  it('取回来变了才再查;没变、没取到都不查', () => {
    wireMarketRefresh();
    const [{ cb }] = h.listeners;
    cb({ outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' });
    cb({ outcome: 'failed', fetchedAt: '2026-10-16T01:00:00.000Z' });
    expect(h.checkUpdates).toHaveBeenCalledTimes(1);
    cb({ outcome: 'changed', fetchedAt: '2026-10-16T01:05:00.000Z' });
    expect(h.checkUpdates).toHaveBeenCalledTimes(2);
  });
});
