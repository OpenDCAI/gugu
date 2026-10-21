import { describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@gugu/session-shared/logger';
import { FakeAcpAgent, makeAcpHarness, makeStartInput } from '../acp-test-support';
import { SessionCell } from '../session/cell';
import { AcpRuntime } from './runtime';

const capability = {
  channel: 'acp-config-option', ack: 'ack-read-back', busy: 'queue-next-turn',
  reloadRequired: false, recovery: 'none',
} as const;

const modes = (currentValue: string) => [{
  id: 'mode', name: 'Mode', category: 'mode' as const, type: 'select' as const, currentValue,
  options: [{ value: 'default', name: 'Read only' }, { value: 'bypassPermissions', name: 'Full access' }],
}];
const effortOptions = (currentValue: string | null) => [{
  id: 'reasoning_effort', name: 'Effort', category: 'thought_level' as const, type: 'select' as const,
  ...(currentValue ? { currentValue } : {}),
  options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
}];
const modelOptions = [{
  id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const,
  currentValue: 'model-a', options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }],
}];

function makeCell() {
  const agent = new FakeAcpAgent();
  const cell = new SessionCell({
    sessionId: 'review', projectId: 'review', providerId: 'claude', acpSessionId: 'review',
    agent: agent.observed(), logger: noopLogger, resolveAttachment: async () => { throw new Error('No attachments'); },
    liveSettings: { model: capability, permission: capability, effort: capability },
  });
  cell.applySessionReady();
  cell.applySessionMeta({ configOptions: modes('bypassPermissions') });
  return { cell, agent };
}

describe('setting recovery preserves the permission boundary and prompt delivery', () => {
  it.each([null, 'existing-session'])('does not start a read-only session with full access (resume=%s)', async (providerSessionId) => {
    const h = makeAcpHarness({ autoApproveModes: {
      'read-only': { id: 'default' }, 'full-access': { id: 'bypassPermissions' },
    } });
    const provider = h.deps.agentHost.get('claude');
    if (!provider?.capabilities.acp.liveSettings) throw new Error('Missing test capability');
    provider.capabilities.acp.liveSettings.permission = capability;
    const configOptions = modes('bypassPermissions');
    h.agent.newSession.mockResolvedValue({ sessionId: 'permission-session', configOptions });
    h.agent.loadSession.mockResolvedValue({ configOptions });
    h.agent.setSessionConfigOption.mockResolvedValue({ configOptions });
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = await runtime.startSession(makeStartInput({
        sessionId: 'permission', permissionMode: 'read-only', providerSessionId,
      }));
      expect(start.success).toBe(false);
      expect(h.agent.prompt).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it.each([true, false])('rejects a wider permission read-back (startup=%s)', async (startupOnly) => {
    const { cell, agent } = makeCell();
    try {
      agent.setSessionConfigOption.mockResolvedValue({ configOptions: modes('bypassPermissions') });
      const result = await cell.setMode('default', { startupOnly });
      expect(result).toMatchObject({ success: false, error: { type: 'set_mode_failed' } });
      await cell.prompt({ text: 'must wait for read-only', origin: 'typed' });
      expect(agent.prompt).not.toHaveBeenCalled();

      // A real confirmation releases the same pending prompt.
      agent.setSessionConfigOption.mockResolvedValue({ configOptions: modes('default') });
      expect((await cell.setMode('default')).success).toBe(true);
      await agent.called('prompt');
      expect(agent.prompt).toHaveBeenCalledOnce();
      expect(cell.config.modeOptions?.selected).toBe('default');
    } finally { cell.dispose(); }
  });

  it('confirms the current model and sends after the requested startup model is rejected', async () => {
    const h = makeAcpHarness({ autoApproveModes: { 'read-only': { id: 'default' } } });
    const configOptions = [...modes('default'), ...modelOptions];
    h.agent.newSession.mockResolvedValue({ sessionId: 'fallback-session', configOptions });
    h.agent.setSessionConfigOption
      .mockRejectedValueOnce(new Error('Invalid value for config option model'))
      .mockResolvedValue({ configOptions });
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = await runtime.startSession(makeStartInput({
        sessionId: 'fallback', model: 'retired-model', permissionMode: 'read-only',
      }));
      expect(start.success).toBe(true);
      expect(h.agent.setSessionConfigOption).toHaveBeenLastCalledWith({
        sessionId: 'fallback-session', configId: 'model', value: 'model-a',
      });
      expect(JSON.stringify(runtime.getChatHistory('fallback'))).toContain('model-unavailable');
      await runtime.sendPrompt('fallback', { text: 'continue', origin: 'typed' });
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      expect(runtime.getSessionState('fallback').queuedPrompts).toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it('does not report a usable session if the current model also cannot be confirmed', async () => {
    const h = makeAcpHarness();
    h.agent.newSession.mockResolvedValue({ sessionId: 'failed', configOptions: modelOptions });
    h.agent.setSessionConfigOption.mockRejectedValue(new Error('configuration unavailable'));
    const runtime = new AcpRuntime(h.deps);
    try {
      const result = await runtime.startSession(makeStartInput({ sessionId: 'failed', model: 'retired' }));
      expect(result.success).toBe(false);
      expect(h.agent.prompt).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  // #6199 —— 启动档位被 provider 拒收时,首句不能被扣在队列里、界面上什么都没有。
  it('confirms the current effort and sends after the requested startup effort is rejected', async () => {
    const h = makeAcpHarness({ autoApproveModes: { 'read-only': { id: 'default' } } });
    const configOptions = [...modes('default'), ...effortOptions('low')];
    h.agent.newSession.mockResolvedValue({ sessionId: 'effort-session', configOptions });
    h.agent.setSessionConfigOption.mockImplementation(async ({ configId, value }: { configId: string; value: string }) => {
      if (configId === 'reasoning_effort' && value === 'ultra') {
        throw new Error('unknown reasoning effort: ultra; model glm-5.3 offers low, medium, high');
      }
      return { configOptions };
    });
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = await runtime.startSession(makeStartInput({
        sessionId: 'effort', effort: 'ultra', permissionMode: 'read-only',
      }));
      expect(start.success).toBe(true);
      expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'effort-session', configId: 'reasoning_effort', value: 'low',
      });
      const history = JSON.stringify(runtime.getChatHistory('effort'));
      expect(history).toContain('effort-unavailable');
      expect(history).toContain('unknown reasoning effort: ultra');
      await runtime.sendPrompt('effort', { text: 'continue', origin: 'typed' });
      expect(h.agent.prompt).toHaveBeenCalledOnce();
      expect(runtime.getSessionState('effort').queuedPrompts).toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it('fails the start when a rejected effort leaves no current level to confirm', async () => {
    const h = makeAcpHarness();
    h.agent.newSession.mockResolvedValue({ sessionId: 'effort-none', configOptions: effortOptions(null) });
    h.agent.setSessionConfigOption.mockRejectedValue(new Error('unknown reasoning effort: ultra'));
    const runtime = new AcpRuntime(h.deps);
    try {
      const result = await runtime.startSession(makeStartInput({ sessionId: 'effort-none', effort: 'ultra' }));
      expect(result).toMatchObject({ success: false, error: { type: 'set_config_failed' } });
      expect(h.agent.prompt).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });

  it('keeps a session without a live effort channel usable when the startup effort cannot be applied', async () => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.get('claude');
    if (!provider?.capabilities.acp) throw new Error('Missing test capability');
    (provider.capabilities.acp as { liveSettings?: unknown }).liveSettings = undefined;
    h.agent.newSession.mockResolvedValue({ sessionId: 'no-channel', configOptions: effortOptions('low') });
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = await runtime.startSession(makeStartInput({ sessionId: 'no-channel', effort: 'high' }));
      expect(start.success).toBe(true);
      expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
      expect(JSON.stringify(runtime.getChatHistory('no-channel'))).not.toContain('effort-unavailable');
      await runtime.sendPrompt('no-channel', { text: 'continue', origin: 'typed' });
      expect(h.agent.prompt).toHaveBeenCalledOnce();
    } finally { await runtime.dispose(); }
  });

  it('starts and sends when the provider reports no effort dimension for a saved startup effort', async () => {
    const h = makeAcpHarness({ autoApproveModes: { 'read-only': { id: 'default' } } });
    const configOptions = modes('default');
    h.agent.newSession.mockResolvedValue({ sessionId: 'no-dimension', configOptions });
    h.agent.setSessionConfigOption.mockResolvedValue({ configOptions });
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = await runtime.startSession(makeStartInput({
        sessionId: 'no-dimension', effort: 'high', permissionMode: 'read-only',
      }));
      expect(start.success).toBe(true);
      expect(h.agent.setSessionConfigOption).not.toHaveBeenCalledWith(expect.objectContaining({ value: 'high' }));
      await runtime.sendPrompt('no-dimension', { text: 'continue', origin: 'typed' });
      expect(h.agent.prompt).toHaveBeenCalledOnce();
    } finally { await runtime.dispose(); }
  });

  it('persists a standalone model notice before another prompt or session close', async () => {
    const onTurnCommitted = vi.fn();
    const h = makeAcpHarness({ onTurnCommitted, autoApproveModes: { 'read-only': { id: 'default' } } });
    const configOptions = [...modes('default'), ...modelOptions];
    h.agent.newSession.mockResolvedValue({ sessionId: 'notice-session', configOptions });
    h.agent.setSessionConfigOption.mockResolvedValue({ configOptions });
    const runtime = new AcpRuntime(h.deps);
    try {
      expect((await runtime.startSession(makeStartInput({
        sessionId: 'notice', model: 'model-b', permissionMode: 'read-only',
      }))).success).toBe(true);
      expect(JSON.stringify(onTurnCommitted.mock.calls)).toContain('model-substituted');
      expect(runtime.getChatHistory('notice').active).toBeNull();
      await runtime.stopSession('notice');
      expect(onTurnCommitted).toHaveBeenCalledOnce();
      expect(onTurnCommitted.mock.calls[0][0].source).toBe('live');
    } finally { await runtime.dispose(); }
  });

  it('does not close an ongoing model turn when a notice arrives', async () => {
    const { cell, agent } = makeCell();
    let finish!: (value: { stopReason: 'end_turn' }) => void;
    agent.prompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    try {
      const prompt = cell.prompt({ text: 'working', origin: 'typed' });
      await agent.called('prompt');
      expect(agent.prompt).toHaveBeenCalledOnce();
      cell.push({ kind: 'session_notice', code: 'model-substituted', detail: 'changed', effectiveValue: 'model-a' });
      expect(cell.history().committed).toHaveLength(0);
      expect(cell.sessionState.lifecycle).toBe('working');
      finish({ stopReason: 'end_turn' });
      await prompt;
      expect(JSON.stringify(cell.history().committed)).toContain('model-substituted');
    } finally { cell.dispose(); }
  });
});
