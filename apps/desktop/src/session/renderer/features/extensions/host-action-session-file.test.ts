// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_HOST_ACTION_METHOD } from '@shared/extensions/host-actions';

const state = vi.hoisted(() => ({
  projects: new Map<string, unknown>(),
  prepare: vi.fn(), open: vi.fn(),
}));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: state.projects }) }));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }));
vi.mock('./extension-surface-store', () => ({ extensionSurfaceStore: { say: vi.fn() } }));
vi.mock('@renderer/features/sessions/session-pane-ready', () => ({ prepareSessionPane: state.prepare }));
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({ openFileInSessionEditor: state.open }));
const { extensionHostActionHandlers } = await import('./host-action-handlers');
const open = (projectId: string | null = 'project', deviceId: string | null = null) => extensionHostActionHandlers[EXTENSION_HOST_ACTION_METHOD]!({
  origin: { sessionId: null, tabId: 'group-folder' },
  action: { kind: 'openSessionFile', sessionId: 'target', projectId, deviceId, path: 'a.txt', ask: true },
});
beforeEach(() => {
  vi.clearAllMocks(); state.projects.clear(); state.open.mockResolvedValue(null);
  state.prepare.mockImplementation(async (projectId: string) => {
    state.projects.set(projectId, { mountedProject: { sessionManager: { sessions: new Map([['target', { viewModel: {} }]]) } } });
  });
});
describe('an App opens a file in a target session that was not prepared', () => {
  it.each([null, 'remote-device'])('prepares the session in its own home project (device: %s)', async (deviceId) => {
    const home = '00000000-0000-4000-8000-000000000001';
    await expect(open(home, deviceId)).resolves.toEqual({ ok: true, opened: undefined });
    const project = deviceId ? `${home}~${deviceId}` : home;
    expect(state.prepare).toHaveBeenCalledWith(project, 'target');
    expect(state.open).toHaveBeenCalledWith(project, 'target', 'a.txt', { beside: true, ask: true });
    expect(state.prepare.mock.invocationCallOrder[0]).toBeLessThan(state.open.mock.invocationCallOrder[0]!);
  });
  it('reports a cancelled choice only to the App caller', async () => {
    state.open.mockResolvedValueOnce(undefined);
    await expect(open()).rejects.toThrow('did not pick');
  });
  it('refuses a missing project without trying another source', async () => {
    await expect(open(null)).rejects.toThrow('no known project');
    expect(state.prepare).not.toHaveBeenCalled();
  });
  it('does not acknowledge an unsuccessful open or failed preparation', async () => {
    state.open.mockRejectedValueOnce(new Error('The person did not pick an App to open it with'));
    await expect(open()).rejects.toThrow('did not pick');
    state.prepare.mockRejectedValueOnce(new Error('workspace unavailable'));
    await expect(open()).rejects.toThrow('workspace unavailable');
    expect(state.open).toHaveBeenCalledTimes(1);
  });
});
