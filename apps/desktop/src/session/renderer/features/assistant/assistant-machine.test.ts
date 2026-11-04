import { beforeEach, expect, it, vi } from 'vitest';
import type { AssistantHomePlace } from '@/lib/assistantHome';

const state = vi.hoisted(() => ({ local: vi.fn(), remote: vi.fn(), acquire: vi.fn(), open: vi.fn(), rootLease: vi.fn(), create: vi.fn(), homeProject: vi.fn(), project: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({
  app: { getHomeDirectory: async () => '/home/me' },
  projects: { acquireTaskDirectory: state.acquire, openProject: state.open, acquireProjectWorkspace: state.rootLease, createProject: state.create },
}) }));
vi.mock('@renderer/features/sessions/implicit-session-home-project', () => ({ ensureImplicitSessionHomeProjectId: state.local }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: {
  ensureTaskWorkspace: state.remote, ensureHomeDir: async () => '/home/me', ensureHomeProject: state.homeProject, ensureProject: state.project,
} }));
vi.mock('./assistant-home-sessions', () => ({ homeTarget: (home: AssistantHomePlace) => home.kind === 'computer' && home.thisDevice ? null : home.deviceId }));
import { openAssistantMachine } from './assistant-machine';

beforeEach(() => {
  vi.clearAllMocks(); state.local.mockResolvedValue('tasks-local'); state.remote.mockResolvedValue('tasks-remote');
  state.acquire.mockResolvedValue({ success: true, data: { workspaceId: 'assistant-cwd' } });
  state.open.mockResolvedValue({ success: true, data: { repositoryWorkspaceId: 'task-root' } });
  state.rootLease.mockImplementation(() => { throw new Error('wrong directory lease'); });
});
const local: AssistantHomePlace = { kind: 'computer', deviceId: 'local', thisDevice: true, label: null, online: true, known: true };
const remote: AssistantHomePlace = { ...local, deviceId: 'other', thisDevice: false };
const cloud: AssistantHomePlace = { kind: 'cloud', deviceId: 'cloud' };
it.each([local, remote, cloud])('opening an assistant on $deviceId never registers its directory as a project', async home => {
  const machine = await openAssistantMachine(home, '/home/me/assistant');
  const projectId = home === local ? 'tasks-local' : 'tasks-remote';
  expect(machine.projectId).toBe(projectId); expect(machine.workspaceId).toBe('assistant-cwd');
  expect(state.acquire).toHaveBeenCalledWith(projectId, '/home/me/assistant');
  expect(state.create).not.toHaveBeenCalled(); expect(state.project).not.toHaveBeenCalled(); expect(state.homeProject).not.toHaveBeenCalled();
  expect(state.rootLease).not.toHaveBeenCalled();
  if (home !== local) expect(state.remote).toHaveBeenCalledWith(home.deviceId, true);
});
it('fails closed instead of creating a home project when an older remote cannot supply a task workspace', async () => {
  state.remote.mockRejectedValue(new Error('TASK_WORKSPACE_UNAVAILABLE'));
  await expect(openAssistantMachine(remote, '/home/me/assistant')).rejects.toThrow('TASK_WORKSPACE_UNAVAILABLE');
  expect(state.homeProject).not.toHaveBeenCalled(); expect(state.acquire).not.toHaveBeenCalled();
});
it('propagates a real directory lease failure instead of reading the task-root directory', async () => {
  state.acquire.mockResolvedValue({ success: false, error: { type: 'acquire-failed' } });
  await expect(openAssistantMachine(local, '/home/me/assistant')).rejects.toThrow('acquire-failed');
  expect(state.open).not.toHaveBeenCalled();
});
