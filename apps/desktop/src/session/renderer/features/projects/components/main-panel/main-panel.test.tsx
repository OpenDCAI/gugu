// @vitest-environment jsdom
// 项目首页不等挂载(product spec「项目」:项目不属于任何一台机器):别的机器上的项目还没挂上(那台机器没连上、
// 或列出时本来就不挂)也照样画首页(挂上由首页自己要,见 use-ensure-mounted);挂过失败的照旧是错误面板。
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@shared/projects';

const mocks = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { projects: { projects: new Map() } } }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/features/projects/hooks/use-confirm-delete-project', () => ({ useConfirmDeleteProject: () => () => {} }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {} }));
vi.mock('./project-home', () => ({ ProjectHome: () => createElement('div', { 'data-testid': 'project-home' }) }));
vi.mock('./pending-project', () => ({ PendingProjectStatus: () => null }));
vi.mock('../../stores/project-selectors', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/project-selectors')>()),
  getProjectStore: () => mocks.store,
}));

const { createUnmountedProject } = await import('../../stores/project');
const { ProjectMainPanel } = await import('./main-panel');

function localProject(): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project',
    baseRef: 'main',
    repositoryWorkspaceId: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
  };
}

let root: Root;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
});

function render(): void {
  act(() => root.render(createElement(ProjectMainPanel, { projectId: 'project-id' })));
}
const showsHome = () => host.querySelector('[data-testid="project-home"]') !== null;

describe('ProjectMainPanel', () => {
  it('shows the home of a project that is not mounted yet', () => {
    mocks.store = createUnmountedProject(localProject(), 'idle');
    render();
    expect(showsHome()).toBe(true);
  });

  it('shows the home while the project is being mounted', () => {
    mocks.store = createUnmountedProject(localProject(), 'opening');
    render();
    expect(showsHome()).toBe(true);
  });

  it('keeps the error panel for a project whose mount failed', () => {
    const store = createUnmountedProject(localProject(), 'idle');
    store.phase = 'error';
    store.error = 'boom';
    mocks.store = store;
    render();
    expect(showsHome()).toBe(false);
    expect(host.textContent).toContain('projects.error.setupFailed');
  });
});
