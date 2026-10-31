import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpChatStore } from './acp-chat-store';

const mocks = vi.hoisted(() => ({ manager: vi.fn(), acquire: vi.fn(), release: vi.fn() }));
vi.mock('./acp-chat-resources', () => ({ acpChatResources: mocks.manager }));
vi.mock('../stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }));
vi.mock('../view/session-actions', () => ({ useSessionTabCommands: () => [] }));
vi.mock('../close-session-tab-flow', () => ({ confirmCloseSessionTab: vi.fn() }));
import { acpChatTabProvider } from './acp-chat-tab-provider';

describe('右栏跨 Agent 标签的资源归属', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.manager.mockReturnValue({ acquire: mocks.acquire, release: mocks.release });
    mocks.acquire.mockReturnValue({ sessionId: 'agent-2' } as AcpChatStore);
  });

  it('跨项目标签获取和释放目标 Agent 的资源，持久化目标项目', () => {
    const ctx = { viewId: 'agent-1', sessionId: 'agent-1', projectId: 'project-1' };
    const state = acpChatTabProvider.onBeforeOpen!({ sessionId: 'agent-2', projectId: 'project-2' }, ctx);
    expect(state).toEqual({ sessionId: 'agent-2', projectId: 'project-2' });
    const entry = { kind: 'acp-chat', tabId: 'tab-2', isPreview: false, state: state! } as const;
    const resource = acpChatTabProvider.initialize(entry, {} as never, ctx);
    acpChatTabProvider.dispose(entry, resource, ctx);
    expect(mocks.manager.mock.calls).toEqual([['agent-2', 'project-2'], ['agent-2', 'project-2']]);
    expect(mocks.acquire).toHaveBeenCalledWith('agent-2');
    expect(mocks.release).toHaveBeenCalledWith('agent-2');
  });

  it('原有标签继续使用原有宿主资源', () => {
    const entry = { kind: 'acp-chat', tabId: 'tab-1', isPreview: false, state: { sessionId: 'agent-1' } } as const;
    const ctx = { viewId: 'host', sessionId: 'host', projectId: 'project-1' };
    acpChatTabProvider.initialize(entry, {} as never, ctx);
    expect(mocks.manager).toHaveBeenCalledWith('host', 'project-1');
  });
});
