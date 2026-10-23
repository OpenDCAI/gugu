import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn().mockResolvedValue({ status: 'accepted' }),
  error: vi.fn(),
  handlers: new Set<(event: { browserId: string; state: string }) => void>(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: (_channel: unknown, cb: (event: { browserId: string; state: string }) => void) => {
    mocks.handlers.add(cb); return () => mocks.handlers.delete(cb);
  } },
  rpc: { sessions: { sendMessage: mocks.sendMessage } },
}));
vi.mock('@renderer/localization/use-session-messages', async () => {
  const { zhCNProjectMessages } = await import('@renderer/localization/messages-projects');
  return { useSessionMessages: () => ({ translate: (key: keyof typeof zhCNProjectMessages, values?: { name?: string }) =>
    zhCNProjectMessages[key].replace('{name}', values?.name ?? '') }) };
});
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));
const { AgentBrowserAssistant } = await import('@renderer/features/browser/agent-browser-assistant');
const owner = { projectId: 'project-A', sessionId: 'agent-A', browserId: 'page-A', workspaceId: 'workspace-A' };
let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness(); });
afterEach(() => harness.cleanup());
const emit = (browserId: string, state: string) => act(async () => mocks.handlers.forEach(cb => cb({ browserId, state })));
const button = (text: string) => [...harness.container.querySelectorAll('button')].find(node => node.textContent?.includes(text))!;

it('names the actual Agent and sends a normal visible message without inventing a paused state', async () => {
  await emit(owner.browserId, 'driving');
  await harness.render(<AgentBrowserAssistant owner={owner} agentName="Codex 118" />);
  expect(harness.container.textContent).toContain('Codex 118');
  expect(harness.container.textContent).toContain('正在操作');
  const pause = button('请暂停');
  await act(async () => pause.click());
  expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith({ projectId: 'project-A', sessionId: 'agent-A',
    clientMessageId: expect.any(String), text: '请暂停操作这个浏览器网页，等我说继续。' });
  expect(button('请暂停')).toBe(pause);
  expect(harness.container.textContent).toContain('正在操作');
  expect(harness.container.textContent).not.toContain('已暂停');
});

it('does not claim the Agent is working merely because Continue was requested', async () => {
  await emit(owner.browserId, 'idle');
  await harness.render(<AgentBrowserAssistant owner={owner} agentName="Codex 118" />);
  await act(async () => button('继续').click());
  expect(mocks.sendMessage.mock.calls[0][0].text).toBe('请继续操作这个浏览器网页。');
  expect(harness.container.textContent).toContain('让 Codex 118 继续');
  await emit('another-page', 'driving');
  expect(harness.container.textContent).toContain('让 Codex 118 继续');
  await emit(owner.browserId, 'driving');
  expect(harness.container.textContent).toContain('正在操作');
});

it('addresses the new owning session after switching pages, and follows its actual name', async () => {
  await harness.render(<AgentBrowserAssistant owner={owner} agentName="Codex 118" />);
  const next = { ...owner, browserId: 'page-B', sessionId: 'agent-B', projectId: 'project-B' };
  await harness.render(<AgentBrowserAssistant owner={next} agentName="Claude 3" />);
  await act(async () => button('继续').click());
  expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({ projectId: 'project-B', sessionId: 'agent-B' });
  expect(harness.container.textContent).toContain('Claude 3');
  expect(harness.container.textContent).not.toContain('Codex 118');
});

it('keeps the one shortcut available when message delivery fails', async () => {
  mocks.sendMessage.mockRejectedValueOnce(new Error('connection lost'));
  await emit(owner.browserId, 'driving');
  await harness.render(<AgentBrowserAssistant owner={owner} agentName="Codex 118" />);
  await act(async () => button('请暂停').click());
  await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('请求未能发送，请重试。'));
  expect(button('请暂停').disabled).toBe(false);
  expect(harness.container.querySelectorAll('button')).toHaveLength(1);
});
