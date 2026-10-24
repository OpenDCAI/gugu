import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  listener: undefined as undefined | ((event: { sessionId: string; reading: { status: string } }) => void),
  summaries: new Map<string, Record<string, unknown>>(),
  environment: vi.fn(() => ({})),
}));
vi.mock('@gugu/core/shared/assistantWorkflow', () => ({ ASSISTANT_CONTEXT_CORE: [] }));
vi.mock('@gugu/session-core/agents/agent-run-context', () => ({ composeAgentSpawnEnv: state.environment }));
vi.mock('@main/core/acp/agent-status-bridge', () => ({ acpAgentStatusBridge: { current: () => state.summaries } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: (_name: string, fn: typeof state.listener) => { state.listener = fn; } } }));
vi.mock('@main/core/sessions/fork-lineage', () => ({ claudeTranscriptDirFor: vi.fn() }));
vi.mock('@main/core/sessions/set-session-id', () => ({ promoteAssistantContextCandidate: vi.fn() }));
vi.mock('@main/core/sessions/assistant-context-lease', () => ({ abandonAssistantContextMigration: vi.fn(), assistantConversationVersion: vi.fn(), claimAssistantContextMigration: vi.fn() }));
vi.mock('@main/core/sessions/getSessions', () => ({ getSessions: async () => [] }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));

const ready = () => ({ lifecycle: 'ready', isGenerating: false, queuedPromptCount: 0, pendingPermissionCount: 0, backgroundAgentCount: 0, backgroundCommandCount: 0 });
const registration = (sessionId = 'assistant') => ({ sessionId, cwd: '/isolated/assistant', memoryDir: '/isolated/memory', options: {},
  runContext: { cli: { kind: 'resolved', path: '/isolated/claude' }, acpAdapterEntry: '/isolated/adapter' } } as never);
const drained = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => { vi.resetModules(); state.summaries.clear(); state.listener = undefined; state.environment.mockClear(); });

describe('assistant idle maintenance admission', () => {
  it('does not put migration ahead of the first inbox message at boot, then attempts once after that turn finishes', async () => {
    const { registerAssistantContextMigration } = await import('./assistant-context-migration');
    state.summaries.set('assistant', ready()); registerAssistantContextMigration(registration());
    state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).not.toHaveBeenCalled();
    state.summaries.set('assistant', { ...ready(), isGenerating: true });
    state.listener?.({ sessionId: 'assistant', reading: { status: 'working' } });
    state.summaries.set('assistant', ready()); state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).toHaveBeenCalledOnce();
    state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).toHaveBeenCalledOnce();
  });
  it('waits for queued input and ignores other sessions working/idle events', async () => {
    const { registerAssistantContextMigration } = await import('./assistant-context-migration');
    state.summaries.set('assistant', ready()); registerAssistantContextMigration(registration());
    state.listener?.({ sessionId: 'executor', reading: { status: 'working' } });
    state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).not.toHaveBeenCalled();
    state.listener?.({ sessionId: 'assistant', reading: { status: 'working' } });
    state.summaries.set('assistant', { ...ready(), queuedPromptCount: 1 });
    state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).not.toHaveBeenCalled();
    state.summaries.set('assistant', ready()); state.listener?.({ sessionId: 'assistant', reading: { status: 'idle' } }); await drained();
    expect(state.environment).toHaveBeenCalledOnce();
  });
});
