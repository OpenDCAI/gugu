import { describe, expect, it, vi } from 'vitest';
import type { FileChangesEvent } from '@shared/core/fs/fsEvents';
import { answerAppFileWatches, type AppFileHeard, type AppFileWatchRequest } from './app-file-watches-elsewhere';

function rig(located = true) {
  let request: (r: AppFileWatchRequest) => void = () => {};
  let back: () => void = () => {};
  const feeds = new Set<(event: FileChangesEvent) => void>();
  const heard: AppFileHeard[] = [];
  const letGo = vi.fn();
  const watchDirectory = vi.fn(async () => letGo);
  const warn = vi.fn();
  answerAppFileWatches({
    onRequest: (handler) => { request = handler; return () => {}; },
    reply: (one) => heard.push(one),
    locate: () => (located ? { projectId: 'remote:d', workspaceId: 'w', root: '/srv/a' } : null),
    onFileChanges: (handler) => { feeds.add(handler); return () => feeds.delete(handler); },
    watchDirectory,
    onMachineBack: (_workspace, handler) => { back = handler; return () => { back = () => {}; }; },
    warn,
  });
  const fire = (update: FileChangesEvent['update'], workspaceId = 'w') => feeds.forEach((feed) => feed({ projectId: 'remote:d', workspaceId, update }));
  const change = (kind: 'create' | 'update' | 'delete', path: string) => ({ kind: 'changes' as const, changes: [{ kind, path, entryType: 'file' as const }] });
  return { machineBack: () => back(), request: (r: AppFileWatchRequest) => request(r), heard, fire, change, letGo, watchDirectory, feeds, warn };
}

describe('a page hearing one file on another machine', () => {
  it('hears that file, by the name it asked with, from the event the file panel hears', () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    r.fire(r.change('update', '/srv/a/docs/other.md'));
    r.fire(r.change('update', '/srv/a/docs/a.md'), 'another-workspace');
    expect(r.heard).toEqual([]);
    r.fire(r.change('delete', '/srv/a/docs/a.md'));
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'changes', changes: [{ kind: 'delete', path: 'docs/a.md' }] } }]);
    r.fire({ kind: 'resync' });
    expect(r.heard.at(-1)).toEqual({ key: 'k', change: { kind: 'resync' } });
  });

  it('has its folder watched there, and lets go with the watch', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: '/srv/a/docs/a.md', on: true });
    await Promise.resolve();
    expect(r.watchDirectory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w' }), '/srv/a/docs');
    r.request({ key: 'k', sessionId: 's', file: '/srv/a/docs/a.md', on: false });
    expect(r.letGo).toHaveBeenCalled();
    expect(r.feeds.size).toBe(0);
  });

  it('says resync when that machine is back, and watches the folder again', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    await Promise.resolve();
    r.machineBack();
    await Promise.resolve();
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'resync' } }]);
    expect(r.watchDirectory).toHaveBeenCalledTimes(2);
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: false });
    r.machineBack();
    expect(r.heard).toHaveLength(1);
  });

  it('asks again for a folder its machine cannot watch yet, then says so', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      r.watchDirectory.mockRejectedValue(new Error('not_found'));
      r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
      await vi.advanceTimersByTimeAsync(3100);
      expect(r.watchDirectory).toHaveBeenCalledTimes(3);
      r.watchDirectory.mockResolvedValue(r.letGo);
      await vi.advanceTimersByTimeAsync(4100);
      expect(r.watchDirectory).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(60000);
      expect(r.watchDirectory).toHaveBeenCalledTimes(4);
      expect(r.warn).not.toHaveBeenCalled();
      r.watchDirectory.mockRejectedValue(new Error('not_found'));
      r.machineBack();
      await vi.advanceTimersByTimeAsync(60000);
      expect(r.watchDirectory).toHaveBeenCalledTimes(10);
      expect(r.warn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops asking when the watch stops', async () => {
    vi.useFakeTimers();
    try {
      const r = rig();
      r.watchDirectory.mockRejectedValue(new Error('not_found'));
      r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
      await vi.advanceTimersByTimeAsync(0);
      r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: false });
      await vi.advanceTimersByTimeAsync(60000);
      expect(r.watchDirectory).toHaveBeenCalledTimes(1);
      expect(r.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('watches no folder for a file at the top, or outside the working copy', async () => {
    const r = rig();
    r.request({ key: 'a', sessionId: 's', file: 'a.md', on: true });
    r.request({ key: 'b', sessionId: 's', file: '/etc/hosts', on: true });
    await Promise.resolve();
    expect(r.watchDirectory).not.toHaveBeenCalled();
  });

  it('says so when this window does not hold the session', () => {
    const r = rig(false);
    r.request({ key: 'k', sessionId: 's', file: 'a.md', on: true });
    expect(r.warn).toHaveBeenCalled();
    expect(r.feeds.size).toBe(0);
  });
});
