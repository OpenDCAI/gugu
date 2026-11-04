import { observable, runInAction } from 'mobx';
import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotRegistry } from './snapshot-registry';
import { rpc } from '@renderer/lib/ipc';
import { viewStateCache } from './view-state-cache';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { viewState: { save: vi.fn().mockResolvedValue(undefined) } } }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('writes disclosure choices immediately without waiting for the normal snapshot debounce', () => {
  vi.useFakeTimers();
  const registry = new SnapshotRegistry();
  const state = observable({ expandedProjectIds: ['project'], expandedSessionIds: ['parent'] });
  const dispose = registry.register('sidebar', () => ({
    expandedProjectIds: [...state.expandedProjectIds], expandedSessionIds: [...state.expandedSessionIds],
  }), 0);
  expect(rpc.viewState.save).not.toHaveBeenCalled();
  runInAction(() => {
    state.expandedProjectIds.splice(0);
    state.expandedSessionIds.splice(0);
  });
  const saved = { expandedProjectIds: [], expandedSessionIds: [] };
  expect(rpc.viewState.save).toHaveBeenLastCalledWith('sidebar', saved);
  expect(viewStateCache.peek('sidebar')).toEqual(saved);
  expect(vi.getTimerCount()).toBe(0);
  dispose();
});

it('retains debouncing for other view snapshots', () => {
  vi.useFakeTimers();
  const state = observable({ view: 'home' });
  const dispose = new SnapshotRegistry().register('navigation-test', () => ({ ...state }));
  runInAction(() => { state.view = 'project'; });
  expect(rpc.viewState.save).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(rpc.viewState.save).toHaveBeenCalledWith('navigation-test', { view: 'project' });
  dispose();
});
