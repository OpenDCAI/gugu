// @vitest-environment jsdom
// 要用的项目还没挂上就挂上(项目首页画的那个、新会话要建进去的那个 —— 后者可以在别的机器上):
// 每个只要一次;挂载中、已挂上、挂过失败的都不再要(失败的重试由人点)。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@shared/projects';

const mocks = vi.hoisted(() => ({
  stores: new Map<string, unknown>(),
  ensureMounted: vi.fn(async (_projectId: string) => {}),
  warn: vi.fn(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { projects: { projects: new Map() } } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: mocks.warn } }));
vi.mock('@renderer/features/projects/stores/project-selectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/projects/stores/project-selectors')>()),
  getProjectStore: (id: string) => mocks.stores.get(id),
  getProjectManagerStore: () => ({ ensureMounted: mocks.ensureMounted }),
}));

const { createUnmountedProject } = await import('../stores/project');
const { useEnsureMounted } = await import('./use-ensure-mounted');

function project(id: string): LocalProject {
  return {
    type: 'local',
    id,
    name: id,
    path: `/${id}`,
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}
function unmounted(id: string, phase: 'idle' | 'opening' | 'error' = 'idle') {
  const store = createUnmountedProject(project(id), phase === 'error' ? 'idle' : phase);
  if (phase === 'error') store.phase = 'error';
  return store;
}

function Probe({ ids }: { ids: string[] }) {
  useEnsureMounted(ids);
  return null;
}

let root: Root;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const render = (ids: string[]) => act(() => root.render(createElement(Probe, { ids })));
const asked = () => mocks.ensureMounted.mock.calls.map(([id]) => id);

beforeEach(() => {
  mocks.stores.clear();
  mocks.ensureMounted.mockClear();
  mocks.ensureMounted.mockImplementation(async () => {});
  mocks.warn.mockClear();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
});

describe('useEnsureMounted', () => {
  it('asks once for each project that is not mounted yet', () => {
    mocks.stores.set('page', unmounted('page'));
    mocks.stores.set('target', unmounted('target'));
    render(['page', 'target', 'page']);
    expect(asked()).toEqual(['page', 'target']);
  });

  it('leaves alone a project being mounted, mounted, or whose mount failed', () => {
    mocks.stores.set('opening', unmounted('opening', 'opening'));
    mocks.stores.set('mounted', { state: 'mounted' });
    mocks.stores.set('failed', unmounted('failed', 'error'));
    render(['opening', 'mounted', 'failed']);
    expect(asked()).toEqual([]);
  });

  it('asks for the new target when the composer moves to a folder on another machine, not again for the page', () => {
    mocks.stores.set('page', unmounted('page'));
    render(['page', 'page']);
    mocks.stores.set('page', unmounted('page', 'opening'));
    mocks.stores.set('remote', unmounted('remote'));
    render(['page', 'remote']);
    expect(asked()).toEqual(['page', 'remote']);
  });

  it('logs a mount that fails instead of leaving it unhandled', async () => {
    mocks.ensureMounted.mockImplementation(async () => {
      throw new Error('machine went away');
    });
    mocks.stores.set('page', unmounted('page'));
    render(['page']);
    await act(async () => {});
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
