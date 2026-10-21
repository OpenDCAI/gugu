import { describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@shared/projects';
import { createUnmountedProject } from './project';
import { projectViewKind } from './project-selectors';

// project-selectors 引入 appState 只为拿 store map,而 appState 一构造就拉起
// SshConnectionStore 去打 IPC。这里只测纯映射函数,把 appState 整个挡掉最干净。
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { projects: { projects: new Map() } },
}));

function localProject(): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project',
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

function erroredStore(errorCode: 'path-not-found' | 'path-access-blocked') {
  const store = createUnmountedProject(localProject(), 'idle');
  store.phase = 'error';
  store.errorCode = errorCode;
  return store;
}

describe('projectViewKind', () => {
  it('routes a blocked path to its own view kind, not the generic mount error', () => {
    // 与 mount_error 分开是因为用户要做的事完全不同:一个是去授权,一个是等或重试。
    expect(projectViewKind(erroredStore('path-access-blocked'))).toBe('permission_blocked');
  });

  it('keeps the existing mapping for a missing path', () => {
    expect(projectViewKind(erroredStore('path-not-found'))).toBe('path_not_found');
  });

  it('falls back to the generic mount error when no code is set', () => {
    const store = createUnmountedProject(localProject(), 'idle');
    store.phase = 'error';
    expect(projectViewKind(store)).toBe('mount_error');
  });
});
