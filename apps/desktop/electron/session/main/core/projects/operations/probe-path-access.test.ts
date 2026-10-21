import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probePathAccess } from './probe-path-access';

const mocks = vi.hoisted(() => ({ opendir: vi.fn() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, opendir: (...args: unknown[]) => mocks.opendir(...args) };
});

afterEach(() => {
  mocks.opendir.mockReset();
});

describe('probePathAccess', () => {
  it('reports ok for a readable directory', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.opendir.mockImplementation((path: string) => actual.opendir(path));
    const dir = await mkdtemp(join(tmpdir(), 'probe-ok-'));
    try {
      await expect(probePathAccess(dir)).resolves.toEqual({ kind: 'ok' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports blocked when the read never returns within the budget', async () => {
    // 这正是未应答的 macOS 权限弹窗的形状:访问既不成功也不失败,就那么挂着。
    mocks.opendir.mockReturnValue(new Promise(() => {}));
    await expect(probePathAccess('/nowhere', 20)).resolves.toEqual({ kind: 'blocked' });
  });

  it('reports failed with the underlying message when the read rejects', async () => {
    mocks.opendir.mockRejectedValue(new Error('EACCES: permission denied'));
    await expect(probePathAccess('/nowhere', 1_000)).resolves.toEqual({
      kind: 'failed',
      message: 'EACCES: permission denied',
    });
  });

  it('folds a failing entry read into failed instead of throwing out of the probe', async () => {
    // read 抛错若只由 opendir 的 onRejected 兜,链尾就是个 reject 的 promise,race 会把它
    // 原样抛出 —— 权限错误于是以未分型的异常穿透到调用方,而不是那个 failed 结果。
    mocks.opendir.mockResolvedValue({
      read: () => Promise.reject(new Error('EPERM: operation not permitted')),
      close: () => Promise.resolve(),
    });
    await expect(probePathAccess('/nowhere', 1_000)).resolves.toEqual({
      kind: 'failed',
      message: 'EPERM: operation not permitted',
    });
  });

  it('reports blocked when opening succeeds but reading an entry hangs', async () => {
    // 目录能 open、内容读不出来 —— 只 open 不 read 的探测会误判成 ok。
    mocks.opendir.mockResolvedValue({
      read: () => new Promise(() => {}),
      close: () => Promise.resolve(),
    });
    await expect(probePathAccess('/nowhere', 20)).resolves.toEqual({ kind: 'blocked' });
  });
});
