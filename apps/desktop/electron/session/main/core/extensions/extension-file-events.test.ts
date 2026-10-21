import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';

// behavior tab-extensions:「tab 自己感知到文件变化并重画」—— agent 的工作能到达 tab 的
// 唯一通路。这份判的是这条通路的三件事:说出去的路径是不是工作副本内的相对路径、
// 同意有没有被**每批重读**、以及订阅停下来时租约和监听有没有一起收干净。

type ChangeCb = (update: {
  kind: 'changes' | 'resync';
  changes?: { kind: 'create' | 'update' | 'delete'; path: string; entryType: string }[];
}) => void;

let capturedCb: ChangeCb | null = null;
let unsubscribed = 0;
let released = 0;
let watchResult: { success: boolean; data?: unknown; error?: unknown } = { success: true };
let granted: string[] = ['files:read'];
/** 监听是异步建起来的(先取运行时租约);建监听、还租约这两步各自告诉用例。 */
let watchCalled = Promise.withResolvers<void>();
let leaseReleased = Promise.withResolvers<void>();

vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: () =>
      Promise.resolve({
        value: {
          files: {
            watchChanges: (_root: string, cb: ChangeCb) => {
              capturedCb = cb;
              watchCalled.resolve();
              return watchResult.success
                ? { success: true, data: { unsubscribe: () => { unsubscribed += 1; } } }
                : watchResult;
            },
          },
        },
        release: () => {
          released += 1;
          leaseReleased.resolve();
        },
      }),
  },
}));

vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => granted }),
}));

vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { watchWorkspaceForSurface } = await import('./extension-file-events');

const ROOT = '/tmp/workspace';
let delivered: ExtensionFileChangeBatch[] = [];

async function start() {
  const watch = watchWorkspaceForSurface({
    extensionId: 'demo-ext',
    workspaceRoot: ROOT,
    deliver: (batch) => delivered.push(batch),
  });
  await watchCalled.promise;
  return watch;
}

const change = (kind: 'create' | 'update' | 'delete', absolute: string) => ({
  kind,
  path: absolute,
  entryType: 'file',
});

beforeEach(() => {
  capturedCb = null;
  unsubscribed = 0;
  released = 0;
  delivered = [];
  granted = ['files:read'];
  watchResult = { success: true };
  watchCalled = Promise.withResolvers<void>();
  leaseReleased = Promise.withResolvers<void>();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('扩展的工作副本监听', () => {
  it('报出去的是工作副本内的相对路径,扩展不必知道工作副本在哪', async () => {
    await start();
    capturedCb!({ kind: 'changes', changes: [change('update', `${ROOT}/src/app.ts`)] });
    expect(delivered).toEqual([{ kind: 'changes', changes: [{ kind: 'update', path: 'src/app.ts' }] }]);
  });

  it('工作副本之外的变化一律丢掉 —— 同意的是这一份副本,不是它的上级', async () => {
    await start();
    capturedCb!({
      kind: 'changes',
      changes: [change('update', '/tmp/somewhere-else/secret.env'), change('create', `${ROOT}/a.txt`)],
    });
    expect(delivered).toEqual([{ kind: 'changes', changes: [{ kind: 'create', path: 'a.txt' }] }]);
  });

  it('全被丢光时不发空批 —— 「有东西变了」却给不出一条,只会让扩展白重读一遍', async () => {
    await start();
    capturedCb!({ kind: 'changes', changes: [change('update', '/tmp/elsewhere/x')] });
    expect(delivered).toEqual([]);
  });

  it('resync 原样转达,且不带路径 —— 猜一份出来比说不清更糟', async () => {
    await start();
    capturedCb!({ kind: 'resync' });
    expect(delivered).toEqual([{ kind: 'resync' }]);
  });

  // 这条是这份文件里最要紧的一条:同意被撤回后必须**下一批就静音**,
  // 而不是等下次重启。订阅时读一次并缓存,会让撤回在整段会话里毫无效果。
  it('撤回 files:read 之后立刻静音,不等重启', async () => {
    await start();
    capturedCb!({ kind: 'changes', changes: [change('update', `${ROOT}/a.txt`)] });
    expect(delivered).toHaveLength(1);

    granted = [];
    capturedCb!({ kind: 'changes', changes: [change('update', `${ROOT}/b.txt`)] });
    capturedCb!({ kind: 'resync' });
    expect(delivered).toHaveLength(1);

    granted = ['files:read'];
    capturedCb!({ kind: 'changes', changes: [change('update', `${ROOT}/c.txt`)] });
    expect(delivered).toHaveLength(2);
  });

  it('stop 会把监听和运行时租约一起收掉 —— 面已经没了,事件不该还在投递', async () => {
    const watch = await start();
    watch.stop();
    expect(unsubscribed).toBe(1);
    expect(released).toBe(1);
    capturedCb!({ kind: 'changes', changes: [change('update', `${ROOT}/a.txt`)] });
    expect(delivered).toEqual([]);
  });

  it('监听建不起来时租约照样还回去,不留一份挂着的运行时', async () => {
    watchResult = { success: false, error: { type: 'fs-error', message: '起不来' } };
    watchWorkspaceForSurface({ extensionId: 'demo-ext', workspaceRoot: ROOT, deliver: () => {} });
    await leaseReleased.promise;
    expect(released).toBe(1);
  });
});
