// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ send: vi.fn(async () => ({ id: 'message', status: 'accepted' })), projects: new Map() }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessions: { sendMessage: state.send } } }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: state.projects }) }));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }));

const { applyExtensionHostAction } = await import('./host-action-handlers');
beforeEach(() => {
  state.send.mockReset().mockResolvedValue({ id: 'message', status: 'accepted' }); state.projects.clear();
  state.projects.set('bound-project', { mountedProject: { sessionManager: { sessions: new Map([['bound-task', { viewModel: {} }]]) } } });
});
const origin = { extensionId: 'task-app', sessionId: 'bound-task', tabId: 'task-tab' };

it('uses the ordinary conversation RPC for the admitted bound task without changing run state', async () => {
  await applyExtensionHostAction({ origin, action: { kind: 'taskMessage', text: '请暂停。' } });
  expect(state.send).toHaveBeenCalledExactlyOnceWith({ projectId: 'bound-project', sessionId: 'bound-task',
    clientMessageId: expect.any(String), text: '请暂停。' });
});
it('does not retarget an unavailable task and does not report an unknown outcome as sent', async () => {
  await expect(async () => applyExtensionHostAction({ origin: { ...origin, sessionId: 'missing-task' }, action: { kind: 'taskMessage', text: '请继续。' } })).rejects.toThrow('no longer open');
  expect(state.send).not.toHaveBeenCalled();
  state.send.mockResolvedValueOnce({ id: 'message', status: 'outcome-unknown' });
  await expect(applyExtensionHostAction({ origin, action: { kind: 'taskMessage', text: '请继续。' } })).rejects.toThrow('unknown');
});
