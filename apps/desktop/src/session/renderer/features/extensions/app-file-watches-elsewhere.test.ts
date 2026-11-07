import { describe, expect, it, vi } from 'vitest';
import type { FileChangesEvent } from '@shared/core/fs/fsEvents';
import { answerAppFileWatches, type AppFileHeard, type AppFileWatchRequest } from './app-file-watches-elsewhere';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

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

describe('a page hearing one folder on another machine', () => {
  it('hears what changes below it by its path in the working copy, not .git or node_modules', () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', folder: '', on: true });
    r.fire(r.change('create', '/srv/a/new.txt'));
    r.fire(r.change('update', '/srv/a/.git/index'));
    r.fire(r.change('update', '/srv/a/node_modules/x/y.js'));
    r.fire(r.change('create', '/srv/b/elsewhere.txt'));
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'changes', changes: [{ kind: 'create', path: 'new.txt' }] } }]);
  });

  it('a named folder: only below it, and that folder is watched there', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', folder: 'docs', on: true });
    await flush();
    expect(r.watchDirectory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w' }), '/srv/a/docs');
    r.fire(r.change('update', '/srv/a/docs2/a.md'));
    r.fire(r.change('update', '/srv/a/docs/a.md'));
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'changes', changes: [{ kind: 'update', path: 'docs/a.md' }] } }]);
    r.request({ key: 'k', sessionId: 's', folder: 'docs', on: false });
    expect(r.letGo).toHaveBeenCalled();
  });

  it('says resync when that machine is back', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', folder: '', on: true });
    await flush();
    r.machineBack();
    await flush();
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'resync' } }]);
    expect(r.watchDirectory).toHaveBeenCalledTimes(2);
  });
});

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
    await flush();
    expect(r.watchDirectory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w' }), '/srv/a/docs');
    r.request({ key: 'k', sessionId: 's', file: '/srv/a/docs/a.md', on: false });
    expect(r.letGo).toHaveBeenCalled();
    expect(r.feeds.size).toBe(0);
  });

  it('says resync when that machine is back, and watches the folder again', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    await flush();
    r.machineBack();
    await flush();
    expect(r.heard).toEqual([{ key: 'k', change: { kind: 'resync' } }]);
    expect(r.watchDirectory).toHaveBeenCalledTimes(2);
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: false });
    r.machineBack();
    expect(r.heard).toHaveLength(1);
  });

  it('says when the folder could not be watched, and asks again when that machine is back', async () => {
    const r = rig();
    r.watchDirectory.mockRejectedValueOnce(new Error('offline'));
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    await flush();
    expect(r.warn).toHaveBeenCalledTimes(1);
    r.machineBack();
    await flush();
    expect(r.watchDirectory).toHaveBeenCalledTimes(2);
  });

  it('says a folder its machine would not watch, and does not ask again by itself', async () => {
    const r = rig();
    r.watchDirectory.mockRejectedValue(new Error('not_found'));
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    await flush();
    expect(r.watchDirectory).toHaveBeenCalledTimes(1);
    expect(r.warn).toHaveBeenCalledTimes(1);
  });

  it('lets go at once of a watch that answers after it stopped', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: true });
    r.request({ key: 'k', sessionId: 's', file: 'docs/a.md', on: false });
    await flush();
    expect(r.letGo).toHaveBeenCalledTimes(1);
  });

  it('watches the top for a file there, and no folder for one outside the working copy', async () => {
    const r = rig();
    r.request({ key: 'k', sessionId: 's', file: 'a.md', on: true });
    await flush();
    expect(r.watchDirectory).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'w' }), '/srv/a');
    r.watchDirectory.mockClear();
    r.request({ key: 'o', sessionId: 's', file: '/tmp/outside.md', on: true });
    await flush();
    expect(r.watchDirectory).not.toHaveBeenCalled();
  });

  it('says so when this window does not hold the session', () => {
    const r = rig(false);
    r.request({ key: 'k', sessionId: 's', file: 'a.md', on: true });
    expect(r.warn).toHaveBeenCalled();
    expect(r.feeds.size).toBe(0);
  });
});
