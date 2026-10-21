import { describe, expect, it } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

// #6552 会话还在起的时候用户选了模型 / 强度:启动在 `session/new` 之后本来就要设这两维(新建会话设记录里
// 的值),那一步设的就是用户选的 —— 一次设定,❌ 不是启动先设旧值、起完再热切一次。

const capability = {
  channel: 'acp-config-option', ack: 'ack-read-back', busy: 'queue-next-turn',
  reloadRequired: false, recovery: 'none',
} as const;

function harnessWithSettings() {
  const h = makeAcpHarness();
  const liveSettings = h.deps.agentHost.get('claude')?.capabilities.acp.liveSettings;
  if (!liveSettings) throw new Error('Missing test capability');
  liveSettings.model = capability;
  liveSettings.effort = capability;
  const current: Record<string, string> = { model: 'model-a', reasoning_effort: 'high' };
  const configOptions = () => [
    {
      id: 'model', name: 'Model', category: 'model' as const, type: 'select' as const,
      currentValue: current.model!,
      options: [{ value: 'model-a', name: 'A' }, { value: 'model-b', name: 'B' }, { value: 'model-c', name: 'C' }],
    },
    {
      id: 'reasoning_effort', name: 'Effort', category: 'thought_level' as const, type: 'select' as const,
      currentValue: current.reasoning_effort!,
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
    },
  ];
  h.agent.setSessionConfigOption.mockImplementation(async ({ configId, value }: { configId: string; value: string }) => {
    current[configId] = value;
    return { configOptions: configOptions() };
  });
  let releaseNewSession!: () => void;
  let failNewSession!: (error: Error) => void;
  h.agent.newSession.mockImplementationOnce(() => new Promise((resolve, reject) => {
    releaseNewSession = () => resolve({ sessionId: 'side-session', configOptions: configOptions() });
    failNewSession = reject;
  }));
  const sets = (configId: string) =>
    h.agent.setSessionConfigOption.mock.calls
      .map(([request]) => request as { configId: string; value: string })
      .filter((request) => request.configId === configId)
      .map((request) => request.value);
  return { h, sets, releaseNewSession: () => releaseNewSession(), failNewSession: (e: Error) => failNewSession(e) };
}

describe('#6552 a choice made while the session starts', () => {
  it('模型:由启动那一步设成所选,只设一次;应答与活会话热切同形', async () => {
    const { h, sets, releaseNewSession } = harnessWithSettings();
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = runtime.startSession(makeStartInput({ sessionId: 'side', model: 'model-a' }));
      await h.agent.called('newSession');
      const chosen = runtime.setModelOption('side', 'model', 'model-b');
      releaseNewSession();
      expect((await start).success).toBe(true);
      expect(await chosen).toMatchObject({ success: true, data: { status: 'applied', effectiveValue: 'model-b' } });
      expect(sets('model')).toEqual(['model-b']);
    } finally { await runtime.dispose(); }
  });

  it('强度:会话记录里没有强度也照样由启动那一步设', async () => {
    const { h, sets, releaseNewSession } = harnessWithSettings();
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = runtime.startSession(makeStartInput({ sessionId: 'side', effort: null }));
      await h.agent.called('newSession');
      const chosen = runtime.setModelOption('side', 'effort', 'low');
      releaseNewSession();
      expect((await start).success).toBe(true);
      expect(await chosen).toMatchObject({ success: true, data: { status: 'applied', effectiveValue: 'low' } });
      expect(sets('reasoning_effort')).toEqual(['low']);
    } finally { await runtime.dispose(); }
  });

  it('那一步已经设过这一维:等启动落定,再照活会话设', async () => {
    const { h, sets, releaseNewSession } = harnessWithSettings();
    const runtime = new AcpRuntime(h.deps);
    try {
      let releaseStartupModel!: () => void;
      const startupModelSet = new Promise<void>((resolve) => { releaseStartupModel = resolve; });
      const echo = h.agent.setSessionConfigOption.getMockImplementation()!;
      h.agent.setSessionConfigOption.mockImplementationOnce(async (request: never) => {
        await startupModelSet;
        return echo(request);
      });
      const start = runtime.startSession(makeStartInput({ sessionId: 'side', model: 'model-a' }));
      await h.agent.called('newSession');
      releaseNewSession();
      await h.agent.whenCalled('startup sets the model', () => sets('model').length >= 1);
      expect(sets('model')).toEqual(['model-a']);
      const chosen = runtime.setModelOption('side', 'model', 'model-c');
      releaseStartupModel();
      expect((await start).success).toBe(true);
      expect(await chosen).toMatchObject({ success: true, data: { status: 'applied', effectiveValue: 'model-c' } });
      expect(sets('model')).toEqual(['model-a', 'model-c']);
    } finally { await runtime.dispose(); }
  });

  it('会话没起来:这次选择如实失败,❌ 不假装设上了', async () => {
    const { h, sets, failNewSession } = harnessWithSettings();
    const runtime = new AcpRuntime(h.deps);
    try {
      const start = runtime.startSession(makeStartInput({ sessionId: 'side', model: 'model-a' }));
      await h.agent.called('newSession');
      const chosen = runtime.setModelOption('side', 'model', 'model-b');
      failNewSession(new Error('claude exited'));
      expect((await start).success).toBe(false);
      expect((await chosen).success).toBe(false);
      expect(sets('model')).toEqual([]);
    } finally { await runtime.dispose(); }
  });
});
