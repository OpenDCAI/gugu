// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalizationProvider, setLocalePreference } from '@/i18n';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { useConfirmDeleteProject } from './use-confirm-delete-project';

const mocks = vi.hoisted(() => ({ list: vi.fn(), impact: vi.fn(), remove: vi.fn(), notice: vi.fn(), log: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {
  automations: { listAutomations: mocks.list },
  projects: { getProjectDeletionImpact: mocks.impact },
} }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => ({ deleteProject: mocks.remove }),
}));
vi.mock('@/lib/notices', () => ({ notify: mocks.notice, dismissNotice: vi.fn() }));
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: mocks.log }) }));

let root: Root, container: HTMLDivElement;
let confirm: ReturnType<typeof useConfirmDeleteProject>;
function Probe() {
  confirm = useConfirmDeleteProject();
  return null;
}
const project = { projectId: 'remote-project', projectLabel: 'Research' };
const settle = async () => { await act(async () => {}); };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.list.mockResolvedValue([]);
  mocks.impact.mockResolvedValue({ tasks: 3, agents: 2, groups: 1 });
  mocks.remove.mockResolvedValue(undefined);
  setLocalePreference('en-US');
  modalStore.closeModal();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<LocalizationProvider><Probe /></LocalizationProvider>));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  modalStore.closeModal();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('project deletion confirmation', () => {
  it('shows automation names before deletion and runs the success callback only after deletion succeeds', async () => {
    mocks.list.mockResolvedValue([{ id: 'scheduled', name: 'Daily report' }]);
    let finish!: () => void;
    mocks.remove.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const onDeleted = vi.fn();
    await act(async () => confirm({ ...project, onDeleted }));
    expect(modalStore.activeModalId).toBe('confirmActionModal');
    expect(mocks.list).toHaveBeenCalledWith(project.projectId);
    expect(mocks.remove).not.toHaveBeenCalled();
    const args = modalStore.activeModalArgs!;
    await act(async () => root.render(args.description));
    expect(container.textContent).toContain('Daily report');
    expect(container.textContent).toContain('Research');
    expect(container.textContent).toContain('Tasks: 3');
    expect(container.textContent).toContain('Bound agents: 2');
    expect(container.textContent).toContain('Associated project groups: 1');
    expect(container.textContent).toContain('can be restored from Task history');
    act(() => args.onSuccess({ dontAskAgain: false, scopeChecked: false }));
    expect(mocks.remove).toHaveBeenCalledWith(project.projectId);
    expect(onDeleted).not.toHaveBeenCalled();
    finish();
    await settle();
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(mocks.notice).not.toHaveBeenCalled();
  });

  it('reports a failed delete instead of navigating as though it succeeded', async () => {
    const failure = Promise.reject(new Error('Remote project removal refused'));
    void failure.catch(() => undefined);
    mocks.remove.mockReturnValue(failure);
    const onDeleted = vi.fn();
    await act(async () => confirm({ ...project, onDeleted }));
    act(() => modalStore.activeModalArgs!.onSuccess({ dontAskAgain: false, scopeChecked: false }));
    await settle();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: 'Remote project removal refused' }));
  });

  it('reports a failed automation read without presenting an empty automation list as safe to delete', async () => {
    mocks.list.mockRejectedValue(new Error('The remote device disconnected'));
    await act(async () => confirm(project));
    expect(modalStore.isOpen).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error', description: 'The remote device disconnected' }));
  });

  it('does not present unreadable impact as zero tasks or agents', async () => {
    mocks.impact.mockRejectedValue(new Error('Task inventory unavailable'));
    await act(async () => confirm(project));
    expect(modalStore.isOpen).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ description: 'Task inventory unavailable' }));
  });

  it('describes recoverable tasks and preserved identities in Chinese', async () => {
    await act(async () => setLocalePreference('zh-CN'));
    await act(async () => confirm(project));
    await act(async () => root.render(modalStore.activeModalArgs!.description));
    expect(container.textContent).toContain('3 个任务');
    expect(container.textContent).toContain('2 个绑定 Agent');
    expect(container.textContent).toContain('1 个关联项目群');
    expect(container.textContent).toContain('任务历史恢复');
    expect(container.textContent).toContain('群成员关系和消息均会保留');
    expect(container.textContent).not.toContain('会话');
  });

  it.each([
    ['en-US', 'has no tasks', 'project record will be deleted', 'can be restored'],
    ['zh-CN', '没有任务', '删除项目记录', '任务历史恢复'],
  ] as const)('describes actual empty-project deletion in %s', async (locale, empty, removed, restorable) => {
    mocks.impact.mockResolvedValue({ tasks: 0, agents: 0, groups: 1 });
    await act(async () => setLocalePreference(locale));
    await act(async () => confirm(project));
    await act(async () => root.render(modalStore.activeModalArgs!.description));
    expect(container.textContent).toContain(empty);
    expect(container.textContent).toContain(removed);
    expect(container.textContent).not.toContain(restorable);
  });

  it('ends an unanswered automation read with an error and ignores a late answer', async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown[]) => void;
    mocks.list.mockReturnValue(new Promise<unknown[]>((resolve) => { finish = resolve; }));
    let completed = false;
    void confirm(project).then(() => { completed = true; });
    await act(async () => vi.runAllTimersAsync());
    expect(completed).toBe(true);
    expect(modalStore.isOpen).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.notice).toHaveBeenCalledWith(expect.objectContaining({ tier: 'error' }));
    finish([]);
    await settle();
    expect(modalStore.isOpen).toBe(false);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
