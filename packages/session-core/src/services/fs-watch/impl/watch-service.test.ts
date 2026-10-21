import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Scope } from '@gugu/session-wire/util';
import { describe, expect, it, vi } from 'vitest';
import type { WatchEvent } from '../api';
import type { WatchBackend, WatchKey, WatchSink } from './backend';
import { nativeWatchBackend } from './native-backend';
import { realpathOrResolve } from './paths';
import { createWatchService } from './watch-service';

// @@@no-real-fs-events(#5796) — 这里的判据只喂假后端的事件。从前两条用例写真文件、再用 5 s 墙钟等
// FSEvents 送回来:mac1 上 fseventsd 饱和时(#4973)投递要好几秒,08-15 → 09-29 它们在 PR 上
// 红了 90 次(重跑即绿),同期一次也没抓到真问题。它们要判的东西已经各有确定性的归处:
// 共享 / 引用计数 / 释放后重订阅 → 本文件的假后端用例;parcel 事件 → { kind, path } 的映射 →
// native-watch.test.ts。下面仍用真后端的两条只判订阅成败与 dispose,不等文件事件。

describe('createWatchService', () => {
  it('shares a backend subscription by normalized root and ignore set', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-engine-'));
    const backend = new FakeWatchBackend();
    const service = createWatchService({ backend });
    const firstEvents: WatchEvent[] = [];
    const secondEvents: WatchEvent[] = [];

    try {
      const first = service.watch(root, (events) => firstEvents.push(...events), {
        ignore: ['b', 'a'],
      });
      const second = service.watch(root, (events) => secondEvents.push(...events), {
        ignore: ['a', 'b'],
      });
      await Promise.all([first.ready(), second.ready()]);

      expect(backend.subscribeCount).toBe(1);
      backend.emit({ root, ignore: ['a', 'b'], recursive: true, coarse: false }, [{ kind: 'create', path: path.join(root, 'a') }]);
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(1);

      await first.release();
      backend.emit({ root, ignore: ['a', 'b'], recursive: true, coarse: false }, [{ kind: 'update', path: path.join(root, 'b') }]);
      expect(firstEvents).toHaveLength(1);
      expect(secondEvents).toHaveLength(2);

      await second.release();
      expect(backend.activeCount).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  it('applies debounce per consumer and forwards resync signals', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-debounce-'));
    const backend = new FakeWatchBackend();
    const service = createWatchService({ backend });
    const events: WatchEvent[] = [];
    let resyncs = 0;

    try {
      const handle = service.watch(root, (batch) => events.push(...batch), {
        debounceMs: 10,
        onResync: () => {
          resyncs += 1;
        },
      });
      await handle.ready();

      backend.emit({ root, ignore: [], recursive: true, coarse: false }, [
        { kind: 'create', path: path.join(root, 'first') },
        { kind: 'update', path: path.join(root, 'second') },
      ]);
      expect(events).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(10);
      expect(events).toHaveLength(2);

      backend.resync({ root, ignore: [], recursive: true, coarse: false });
      expect(resyncs).toBe(1);

      await handle.release();
    } finally {
      vi.useRealTimers();
      await service.dispose();
    }
  });

  it('opens a fresh backend subscription when a root is watched again after its last release', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-fs-watch-rewatch-'));
    const backend = new FakeWatchBackend();
    const service = createWatchService({ backend });
    const key = { root, ignore: [], recursive: true, coarse: false };
    const events: WatchEvent[] = [];

    try {
      const first = service.watch(root, () => {});
      await first.ready();
      await first.release();
      expect(backend.activeCount).toBe(0);

      const second = service.watch(root, (incoming) => events.push(...incoming));
      await second.ready();
      expect(backend.subscribeCount).toBe(2);
      expect(backend.activeCount).toBe(1);

      backend.emit(key, [{ kind: 'create', path: path.join(root, 'after-rewatch.txt') }]);
      expect(events).toEqual([{ kind: 'create', path: path.join(root, 'after-rewatch.txt') }]);

      await second.release();
      expect(backend.activeCount).toBe(0);
    } finally {
      await service.dispose();
    }
  });

  // Linux trees are directory-backed (@@@tree-by-directories in native-backend.ts): a recursive
  // subscription opens no native watch of its own, so there is no subscription failure to surface.
  it.skipIf(process.platform === 'linux')('surfaces watcher subscription failures through ready()', async () => {
    // @@@unique-missing-root(#6259) — 「不存在的根」必须只属于这一次运行。从前用
    // `tmpdir()/…-${Date.now()}`,并发的另一次运行同一毫秒拿到同名、先把它 mkdir 出来,这边的
    // ready() 就 resolve 了(mac1 16 路共用 TMPDIR 时 4/160 红);建出来的目录也从不删,TMPDIR 里攒了 777 个。
    const parent = await mkdtemp(path.join(tmpdir(), 'emdash-shared-watch-missing-'));
    const root = path.join(parent, 'root');
    const watch = createNativeWatchService();

    try {
      const handle = watch.watch(root, () => {});

      await expect(handle.ready()).rejects.toThrow();
      await handle.release();

      await mkdir(root, { recursive: true });
      const recovered = watch.watch(root, () => {});
      await expect(recovered.ready()).resolves.toBeUndefined();
      await recovered.release();
    } finally {
      await watch.dispose();
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('disposes active handles by releasing their shared native subscription', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'emdash-shared-watch-dispose-'));
    const watch = createNativeWatchService();
    const handle = watch.watch(root, () => {});

    await handle.ready();
    await expect(watch.dispose()).resolves.toBeUndefined();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});

class FakeWatchBackend implements WatchBackend {
  subscribeCount = 0;
  private readonly sinks = new Map<string, WatchSink>();

  get activeCount(): number {
    return this.sinks.size;
  }

  async subscribe(key: WatchKey, sink: WatchSink, scope: Scope): Promise<void> {
    this.subscribeCount += 1;
    const keyId = keyOf(key);
    this.sinks.set(keyId, sink);
    scope.add(() => {
      this.sinks.delete(keyId);
    });
  }

  emit(key: WatchKey, events: WatchEvent[]): void {
    this.sinks.get(keyOf(key))?.events(events);
  }

  resync(key: WatchKey): void {
    this.sinks.get(keyOf(key))?.resync();
  }
}

function createNativeWatchService() {
  return createWatchService({ backend: nativeWatchBackend() });
}

function keyOf(key: WatchKey): string {
  return JSON.stringify({ root: realpathOrResolve(key.root), ignore: [...key.ignore].sort() });
}
