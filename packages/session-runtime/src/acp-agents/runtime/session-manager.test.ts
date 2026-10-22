import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { IAcpBehavior } from '@gugu/session-core/agents/plugins';
import { err, isOk } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../tests/support/awaitCondition';
import {
  FakeAcpTerminalProcess,
  makeAcpHarness,
  makeStartInput,
  testPluginHost,
  untilSessionSummary,
} from '../acp-test-support';
import { AcpRuntime } from './runtime';
import type { AcpStartInput } from './types';

function modeConfigOptions(selected: 'agent' | 'agent-full-access') {
  return [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode' as const,
      type: 'select' as const,
      currentValue: selected,
      options: [
        { value: 'agent', name: 'Agent' },
        { value: 'agent-full-access', name: 'Agent (full access)' },
      ],
    },
  ];
}

async function startHarness(
  sessionId = 'conv-1',
  options?: Parameters<typeof makeAcpHarness>[0],
) {
  const h = makeAcpHarness(options);
  const rt = new AcpRuntime(h.deps);
  const result = await rt.startSession(makeStartInput({ sessionId }));
  expect(isOk(result)).toBe(true);
  return { h, rt, client: h.client(), providerSessionId: 'session-1', sessionId };
}

function platformInjection() {
  return {
    model: 'gpt-5.6-sol',
    providerId: 'gugu_platform',
    providerLabel: 'Gugu platform',
    baseUrl: 'https://relay.example/v1',
    apiKey: 'session-token',
    spawnEnv: {},
  };
}

describe('AcpRuntime session manager', () => {
  /**
   * 插件清单漏了 liveSettings 声明是**本仓自己的 bug**,日志要响亮(error 档)——
   * 但响亮 ❌ 不等于杀掉用户的会话。owner 2026-09-19:「任何 bug 都不应该让会话打不开」。
   * ⇒ 会话照常开,事实落成转录里的一行(spec `session-always-openable`)。
   */
  it('opens the session and records a notice when the provider host omits the live settings declaration', async () => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.get('claude');
    if (!provider) throw new Error('test provider missing');
    delete (provider.capabilities.acp as { liveSettings?: unknown }).liveSettings;
    const rt = new AcpRuntime(h.deps);

    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-undeclared' });
    const result = await rt.startSession(makeStartInput({
      sessionId: 'conv-undeclared-live-settings',
      model: 'gpt-5.5',
    }));

    expect(isOk(result)).toBe(true);
    // 没有 model 维度时不发一条注定无法确认的设置；通知独立落盘。
    const history = JSON.stringify(rt.getChatHistory('conv-undeclared-live-settings'));
    expect(history).toContain('session-notice');
    expect(history).toContain('model-unavailable');
    // provider(这里是我们自己漏声明)那句原话必须留在行里,否则事后没人知道该去修什么。
    expect(history).toContain('does not expose model configuration');
  });

  it('owns initial and startup prompts in the machine queue before session/new returns', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let resolveNewSession!: (value: { sessionId: string }) => void;
    h.agent.newSession.mockImplementationOnce(
      () => new Promise<{ sessionId: string }>((resolve) => { resolveNewSession = resolve; })
    );

    const starting = rt.startSession(makeStartInput({
      sessionId: 'conv-startup-queue',
      initialQueue: [{ text: 'first', origin: 'manual' }],
    }));
    await untilSessionSummary(rt, 'conv-startup-queue', 'the prompt is queued on the starting machine', (summary) => (summary?.queuedPromptCount ?? 0) >= 1);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-startup-queue']?.queuedPromptCount).toBe(1);
    await h.agent.called('newSession');
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(rt.adapterProvenance('conv-startup-queue')).toBeNull();

    await expect(rt.queuePrompt('conv-startup-queue', { text: 'second', origin: 'manual' }))
      .resolves.toEqual({ success: true, data: { queued: true } });
    expect(rt.getSessionState('conv-startup-queue').queuedPrompts.map((prompt) => prompt.text))
      .toEqual(['first', 'second']);

    resolveNewSession({ sessionId: 'session-startup-queue' });
    await expect(starting).resolves.toEqual({ success: true, data: { providerSessionId: 'session-startup-queue' } });
    expect(rt.adapterProvenance('conv-startup-queue')).not.toBeNull();
  });

  // #6823 来路是生产者写明的事实:runtime 照单用,不从文字里猜。一条没写来路的启动句是生产者的漏洞,
  // 响亮地拒掉 —— 旧的迁移会把这个 `<gugu_deliveries>` 批认成人当面打的字。
  it('refuses a startup prompt that does not say where it came from, instead of guessing from its text', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const batch = '<gugu_deliveries>\n<gugu_delivery route="dm" from="Bob" msg="msg:m-1"><![CDATA[a]]></gugu_delivery>\n</gugu_deliveries>';

    await expect(rt.startSession(makeStartInput({
      sessionId: 'conv-startup-no-origin',
      initialQueue: [{ text: batch }],
    }))).rejects.toThrow(/has no explicit origin/);
    expect(h.agent.prompt).not.toHaveBeenCalled();
  });

  it('creates the starting machine when queuePrompt wins the startSession race', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let resolveNewSession!: (value: { sessionId: string }) => void;
    h.agent.newSession.mockImplementationOnce(
      () => new Promise<{ sessionId: string }>((resolve) => { resolveNewSession = resolve; })
    );
    const startInput = makeStartInput({ sessionId: 'conv-queue-wins-race' });

    const queued = rt.queuePrompt(
      'conv-queue-wins-race',
      { text: 'second', origin: 'manual' },
      startInput,
    );
    await untilSessionSummary(rt, 'conv-queue-wins-race', 'the prompt is queued on the starting machine', (summary) => (summary?.queuedPromptCount ?? 0) >= 1);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-queue-wins-race']?.queuedPromptCount).toBe(1);
    await expect(queued).resolves.toEqual({ success: true, data: { queued: true } });
    expect(rt.getSessionState('conv-queue-wins-race').queuedPrompts.map((prompt) => prompt.text))
      .toEqual(['second']);

    await h.agent.called('newSession');
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    resolveNewSession({ sessionId: 'session-queue-wins-race' });
    await h.agent.whenCalled('the queued prompt is sent to the new session', () =>
      h.agent.prompt.mock.calls.some(([request]) =>
        (request as { sessionId?: string } | undefined)?.sessionId === 'session-queue-wins-race'));
    expect(h.agent.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-queue-wins-race',
    }));
  });

  it('backfills connection image capability on the starting machine', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
      },
    });
    let resolveNewSession!: (value: { sessionId: string }) => void;
    h.agent.newSession.mockImplementationOnce(
      () => new Promise<{ sessionId: string }>((resolve) => { resolveNewSession = resolve; })
    );

    const starting = rt.startSession(makeStartInput({ sessionId: 'conv-image-capability' }));
    await h.agent.called('newSession');
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(rt.sessionLiveModels('conv-image-capability')?.states.config.snapshot().data.acceptsImagePrompts)
      .toBe(true);

    resolveNewSession({ sessionId: 'session-image-capability' });
    await expect(starting).resolves.toEqual({ success: true, data: { providerSessionId: 'session-image-capability' } });
  });

  // spec idle-reclaim:宿主只停「停了能按原 session 接回来」的会话,依据就是摘要里的这一格。两个方向都核。
  it.each([true, false])('reports in the summary whether the adapter can load the session back (loadSession=%s)', async (loadSession) => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({ protocolVersion: 1, agentCapabilities: { loadSession } });
    const sessionId = `conv-load-capability-${String(loadSession)}`;

    await expect(rt.startSession(makeStartInput({ sessionId }))).resolves.toMatchObject({ success: true });
    expect(rt.sessionsListLiveModel().states.list.snapshot().data[sessionId]?.canLoadSession).toBe(loadSession);
  });

  it('keeps a reload prompt in the starting machine while session/load is pending', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let resolveLoad!: (value: Record<string, never>) => void;
    h.agent.loadSession.mockImplementationOnce(
      () => new Promise<Record<string, never>>((resolve) => { resolveLoad = resolve; })
    );
    const startInput = makeStartInput({
      sessionId: 'conv-load-queue-race',
      providerSessionId: 'provider-session',
    });

    const queued = rt.queuePrompt(
      'conv-load-queue-race',
      { text: 'after reload', origin: 'manual' },
      startInput,
    );
    await untilSessionSummary(rt, 'conv-load-queue-race', 'the prompt is queued on the starting machine', (summary) => (summary?.queuedPromptCount ?? 0) >= 1);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-load-queue-race']?.queuedPromptCount).toBe(1);
    await expect(queued).resolves.toEqual({ success: true, data: { queued: true } });
    await h.agent.called('loadSession');
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-load-queue-race').queuedPrompts.map((prompt) => prompt.text))
      .toEqual(['after reload']);

    resolveLoad({});
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
  });

  /**
   * #6762 聊天面还没挂上会话时发的话,主进程在会话已活着时转成纯 `queuePrompt`(`forward-live`)。
   * 会话此刻空闲 ⇒ 这一句必须当场开轮;从前它停在空闲会话的队列里,再没有任何边界来抽干。
   */
  it('queuePrompt on a ready idle session starts the turn instead of parking it (#6762)', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await expect(rt.startSession(makeStartInput({ sessionId: 'conv-idle-queue' })))
      .resolves.toMatchObject({ success: true });
    expect(rt.adapterProvenance('conv-idle-queue')).not.toBeNull();

    await expect(rt.queuePrompt('conv-idle-queue', { text: 'sent while the panel attached', origin: 'manual' }))
      .resolves.toEqual({ success: true, data: { queued: false } });

    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-idle-queue').queuedPrompts).toEqual([]);
  });

  /** 同一个入口落在 `session/load` 重放里:先扣着,重放一结束就发 —— ❌ 退化成「发送失败」。 */
  it('queuePrompt during session/load replay is held and sent once the replay ends (#6762)', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let resolveLoad!: (value: Record<string, never>) => void;
    h.agent.loadSession.mockImplementationOnce(
      () => new Promise<Record<string, never>>((resolve) => { resolveLoad = resolve; })
    );
    const starting = rt.startSession(makeStartInput({
      sessionId: 'conv-replay-queue',
      providerSessionId: 'provider-session',
    }));
    await h.agent.called('loadSession');
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-replay-queue').lifecycle).toBe('replaying');

    await expect(rt.queuePrompt('conv-replay-queue', { text: 'typed during replay', origin: 'manual' }))
      .resolves.toEqual({ success: true, data: { queued: true } });
    expect(rt.getSessionState('conv-replay-queue').queuedPrompts.map((prompt) => prompt.text))
      .toEqual(['typed during replay']);
    expect(h.agent.prompt).not.toHaveBeenCalled();

    resolveLoad({});
    await expect(starting).resolves.toMatchObject({ success: true });
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-replay-queue').queuedPrompts).toEqual([]);
  });

  it('restores the machine queue snapshot when a worker is recreated', async () => {
    let snapshot: Array<{ text: string; origin?: 'manual' | 'typed' | 'communication' }> = [
      { text: 'survived', origin: 'manual' },
    ];
    const promptQueueStore = {
      load: vi.fn(() => snapshot),
      save: vi.fn((_sessionId: string, prompts: readonly { text: string }[]) => {
        snapshot = prompts.map(({ text, ...rest }) => ({ text, ...rest }));
      }),
      clear: vi.fn(() => { snapshot = []; }),
    };
    const h = makeAcpHarness({ promptQueueStore });
    const rt = new AcpRuntime(h.deps);

    await expect(rt.startSession({
      ...makeStartInput({ sessionId: 'conv-queue-restart', providerSessionId: 'provider-session' }),
      providerSessionId: 'provider-session',
    })).resolves.toEqual({ success: true, data: { providerSessionId: 'provider-session' } });

    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    expect(h.agent.prompt.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'provider-session',
      prompt: [{ type: 'text', text: 'survived' }],
    });
    expect(promptQueueStore.load).toHaveBeenCalledWith('conv-queue-restart');
    expect(promptQueueStore.clear).toHaveBeenCalledWith('conv-queue-restart');
  });

  it('lets a provider resolve a runtime fork and loads the resolved child session', async () => {
    const resolved = vi.fn().mockResolvedValue({ loadProviderSessionId: 'ses_http-child' });
    const h = makeAcpHarness({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: (io, toClient) => h.agent.behavior.connect(io, toClient),
        resolveForkSource: resolved,
      },
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-http',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'ses_source',
        forkSourceSession: {
          id: 'source-conversation',
          title: 'Source',
          providerId: 'test',
          providerSessionEndpoint: 'http://127.0.0.1:1234',
        },
      })
    );

    expect(result).toEqual({ success: true, data: { providerSessionId: 'ses_http-child' } });
    expect(resolved).toHaveBeenCalledWith({
      sourceProviderSessionId: 'ses_source',
      sourceSession: expect.objectContaining({ id: 'source-conversation' }),
      host: { cwd: '/tmp/workspace', workspaceId: 'ws-1' },
    });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_http-child' }));
    expect(h.agent.unstable_forkSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });

  it('passes the live parent ACP connection to a provider runtime fork resolver', async () => {
    const forkSession = vi.fn().mockResolvedValue({ sessionId: 'ses_acp-child' });
    const resolved = vi.fn(async (input: Parameters<NonNullable<IAcpBehavior['resolveForkSource']>>[0]) => {
      expect(input.sourceConnection?.supportsForkSession).toBe(true);
      const forked = await input.sourceConnection!.agent.unstable_forkSession!({
        cwd: input.host.cwd,
        sessionId: input.sourceProviderSessionId,
        mcpServers: [],
      });
      return { loadProviderSessionId: forked.sessionId };
    });
    const h = makeAcpHarness({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: (io, toClient) => h.agent.behavior.connect(io, toClient),
        resolveForkSource: resolved,
      },
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'ses_acp-source' });
    h.agent.unstable_forkSession = forkSession;

    await expect(rt.startSession(makeStartInput({
      sessionId: 'source-conversation',
    }))).resolves.toEqual({ success: true, data: { providerSessionId: 'ses_acp-source' } });
    await expect(rt.startSession(makeStartInput({
      sessionId: 'side-chat:acp-view',
      sourceSessionId: 'source-conversation',
      forkFromProviderSessionId: 'ses_acp-source',
      forkSourceSession: {
        id: 'source-conversation',
        title: 'Source',
        providerId: 'claude',
      },
    }))).resolves.toEqual({ success: true, data: { providerSessionId: 'ses_acp-child' } });

    expect(resolved).toHaveBeenCalledWith(expect.objectContaining({
      sourceProviderSessionId: 'ses_acp-source',
      sourceSession: expect.objectContaining({ id: 'source-conversation' }),
      sourceConnection: expect.objectContaining({ supportsForkSession: true }),
    }));
    expect(forkSession).toHaveBeenCalledWith({
      cwd: '/tmp/workspace',
      sessionId: 'ses_acp-source',
      mcpServers: [],
    });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_acp-child' }));
  });

  it('does not fall back to a fresh session when runtime fork source facts are missing', async () => {
    const resolved = vi.fn();
    const h = makeAcpHarness({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: (io, toClient) => h.agent.behavior.connect(io, toClient),
        resolveForkSource: resolved,
      },
    });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.startSession(makeStartInput({
      sessionId: 'side-chat:missing-source-facts',
      sourceSessionId: 'source-conversation',
      forkFromProviderSessionId: 'ses_source',
    }));

    expect(result).toMatchObject({ success: false, error: { type: 'initialize_failed' } });
    expect(JSON.stringify(result)).toContain('runtime fork source facts are unavailable');
    expect(resolved).not.toHaveBeenCalled();
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.unstable_forkSession).not.toHaveBeenCalled();
  });

  it('forks through ACP without loading or creating a replacement session', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-1',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
      })
    );

    expect(result).toEqual({ success: true, data: { providerSessionId: 'forked-session' } });
    expect(h.agent.unstable_forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'source-session', cwd: '/tmp/workspace' })
    );
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('side-chat:view-1')).not.toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data).toEqual({});
  });

  it('creates a metadata fork in its own adapter process and does not load the parent', async () => {
    const h = makeAcpHarness();
    h.deps.agentHost = testPluginHost({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: h.agent.behavior.connect,
        forkViaNewSessionMeta: (sourceProviderSessionId) => ({
          claudeCode: { options: { resume: sourceProviderSessionId, forkSession: true } },
        }),
      },
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'source-session' })
      .mockResolvedValueOnce({ sessionId: 'forked-session' });

    await expect(rt.startSession(makeStartInput({
      sessionId: 'source-conversation',
    }))).resolves.toEqual({ success: true, data: { providerSessionId: 'source-session' } });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:meta-view',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
        providerSessionId: 'source-session',
        sessionMeta: {
          claudeCode: {
            options: {
              env: {
                ANTHROPIC_MODEL: 'gugu/glm-5.2',
              },
            },
          },
        } as unknown as AcpStartInput['sessionMeta'],
      })
    );

    expect(result).toEqual({ success: true, data: { providerSessionId: 'forked-session' } });
    expect(h.children).toHaveLength(2);
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({
          claudeCode: {
            options: {
              resume: 'source-session',
              forkSession: true,
              persistSession: false,
              env: {
                ANTHROPIC_MODEL: 'gugu/glm-5.2',
              },
            },
          },
        }),
      })
    );
    expect(rt.adapterProvenance('side-chat:meta-view')).not.toEqual(
      rt.adapterProvenance('source-conversation')
    );
  });

  it('opens a metadata fork from the durable parent session without a live parent connection', async () => {
    const h = makeAcpHarness();
    h.deps.agentHost = testPluginHost({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: h.agent.behavior.connect,
        forkViaNewSessionMeta: (sourceProviderSessionId) => ({
          claudeCode: { options: { resume: sourceProviderSessionId, forkSession: true } },
        }),
      },
    });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.startSession(makeStartInput({
      sessionId: 'side-chat:missing-live-source',
      sourceSessionId: 'source-conversation',
      forkFromProviderSessionId: 'source-session',
    }));

    expect(result).toEqual({ success: true, data: { providerSessionId: 'session-1' } });
    expect(h.children).toHaveLength(1);
  });

  it('rejects a metadata fork that returns the source session id before registering it', async () => {
    const h = makeAcpHarness();
    h.deps.agentHost = testPluginHost({
      acpBehavior: {
        buildSpawn: () => ({ command: '/fake/node', args: ['agent.js'], env: {} }),
        connect: h.agent.behavior.connect,
        forkViaNewSessionMeta: (sourceProviderSessionId) => ({
          claudeCode: { options: { resume: sourceProviderSessionId, forkSession: true } },
        }),
      },
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'source-session' })
      .mockResolvedValueOnce({ sessionId: 'source-session' });

    await expect(rt.startSession(makeStartInput({
      sessionId: 'source-conversation',
    }))).resolves.toEqual({ success: true, data: { providerSessionId: 'source-session' } });

    const result = await rt.startSession(makeStartInput({
      sessionId: 'side-chat:source-id-returned',
      sourceSessionId: 'source-conversation',
      forkFromProviderSessionId: 'source-session',
      providerSessionId: 'source-session',
    }));

    expect(result).toMatchObject({ success: false, error: { type: 'new_session_failed' } });
    expect(JSON.stringify(result)).toContain('adapter returned the source session id for a runtime fork');
    expect(JSON.stringify(result)).toContain('refusing to register a fork that would overwrite the live parent');
    expect(h.children).toHaveLength(2);
    expect(rt.sessionLiveModels('side-chat:source-id-returned')).toBeNull();
    expect(rt.adapterProvenance('side-chat:source-id-returned')).toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['side-chat:source-id-returned']).toBeUndefined();
  });

  // 侧边聊天不该在 provider 那边留下历史。claude 侧靠 Agent SDK 的 `persistSession: false`
  // (走 `_meta.claudeCode.options` —— claude-agent-acp 把这一格整体展开进 SDK options)。
  // 漏掉它,provider 会在 `~/.claude/projects/` 落一份真 transcript,随后被外部 fork 捕获扫描
  // 当成「产品外面 fork 的」补登记成正式会话,运行时分叉冒回会话列表(#4230)。
  it('marks every ACP fork as non-persistent, platform envelope or not', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    // BYOK 会话:没有平台信封 —— 这正是原先 `_meta` 会整个缺席的那一档。
    await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-1',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
      })
    );

    const request = h.agent.unstable_forkSession.mock.calls[0]?.[0] as {
      _meta?: { claudeCode?: { options?: Record<string, unknown> } };
    };
    expect(request._meta?.claudeCode?.options?.persistSession).toBe(false);
  });

  it('adds non-persistence without clobbering an existing platform envelope', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-1',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
        sessionMeta: {
          claudeCode: { options: { settings: '/tmp/relay-settings.json' } },
        } as unknown as AcpStartInput['sessionMeta'],
      })
    );

    const request = h.agent.unstable_forkSession.mock.calls[0]?.[0] as {
      _meta?: { claudeCode?: { options?: Record<string, unknown> } };
    };
    // 平台中转的 settings 还在 —— 少了它,分叉会退回用户自己的网关(界面写 A、实际跑 B)。
    expect(request._meta?.claudeCode?.options).toEqual({
      settings: '/tmp/relay-settings.json',
      persistSession: false,
    });
  });

  // spec session-fork-share:**持久分叉**(产品里的「Fork 会话」)与运行时分叉走的是两条路。
  // 判据是带不带 `sourceConversationId` —— 后者只有运行时视图(侧边聊天)才有。
  // 持久分叉要的是一个**独立**的新 provider 会话 id,所以必须走 `session/fork`;拿到之后
  // 原样交给 `session/load`,重开走的也是它 —— 继承来的历史照常回放。
  it('persists a fork: session/fork for a fresh id, then loads it like any other session', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-fork-1',
        // ❌ 没有 sourceConversationId —— 这一条就是「持久分叉」的判据本身。
        forkFromProviderSessionId: 'source-session',
        providerSessionId: null,
      })
    );

    expect(result).toEqual({ success: true, data: { providerSessionId: 'forked-session' } });
    expect(h.agent.unstable_forkSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'source-session' })
    );
    // 分叉产出的那个 id 必须**原样**成为这条会话的 id:落库的是它,重开载入的也是它。
    expect(h.agent.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'forked-session' })
    );
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });

  // ⚠️ 持久分叉**不能**扣上不落库的开关:扣了就是一条重开即消失的会话,
  // 而症状要到用户下次打开它时才出现。两家各有各的名字,所以两个都要检。
  it('never marks a persistent fork as ephemeral (either provider dialect)', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    await rt.startSession(
      makeStartInput({
        sessionId: 'conv-fork-2',
        forkFromProviderSessionId: 'source-session',
        providerSessionId: null,
      })
    );

    const request = h.agent.unstable_forkSession.mock.calls[0]?.[0] as {
      _meta?: {
        claudeCode?: { options?: Record<string, unknown> };
        gugu?: { ephemeralFork?: boolean };
      };
    };
    expect(request._meta?.claudeCode?.options?.persistSession).toBeUndefined();
    expect(request._meta?.gugu?.ephemeralFork).toBe(false);
  });

  // 阳控:同一个开关在**运行时分叉**上必须是 true —— 否则上面那条即使写死 false 也会绿。
  it('still marks a runtime-view fork as ephemeral', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-9',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
      })
    );

    const request = h.agent.unstable_forkSession.mock.calls[0]?.[0] as {
      _meta?: {
        claudeCode?: { options?: Record<string, unknown> };
        gugu?: { ephemeralFork?: boolean };
      };
    };
    expect(request._meta?.claudeCode?.options?.persistSession).toBe(false);
    expect(request._meta?.gugu?.ephemeralFork).toBe(true);
    expect(h.agent.loadSession).not.toHaveBeenCalled();
  });

  it('isolates a fork from a live ACP source adapter', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'source-session' });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    await rt.startSession(makeStartInput({ sessionId: 'source-conversation' }));
    await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:view-2',
        forkFromProviderSessionId: 'source-session',
      })
    );

    expect(h.children).toHaveLength(2);
  });

  it('fails a fork when the provider does not advertise session/fork', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:unsupported',
        forkFromProviderSessionId: 'source-session',
      })
    );

    expect(result).toMatchObject({ success: false, error: { type: 'new_session_failed' } });
    expect(JSON.stringify(result)).toContain('does not support ACP session/fork');
    expect(h.agent.unstable_forkSession).not.toHaveBeenCalled();
    expect(h.agent.loadSession).not.toHaveBeenCalled();
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });

  it('classifies the exact Codex -32600 no-rollout fork failure without any fallback', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockRejectedValueOnce({
      code: -32600,
      message: 'no rollout found for thread id 019ff4fc-1e4b-7a20-a24a-353f95aa51b6',
    });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:no-rollout',
        forkFromProviderSessionId: 'source-session',
      })
    );

    expect(result).toMatchObject({ success: false, error: { type: 'provider_session_missing' } });
    expect(JSON.stringify(result)).toContain('-32600');
    expect(JSON.stringify(result)).toContain('no rollout found');
    expect(h.agent.unstable_forkSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(h.agent.loadSession).not.toHaveBeenCalled();
  });

  it('does not misclassify another -32600 fork failure as a missing rollout', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockRejectedValueOnce({
      code: -32600,
      message: 'invalid request',
    });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:other-invalid-request',
        forkFromProviderSessionId: 'source-session',
      })
    );

    expect(result).toMatchObject({ success: false, error: { type: 'new_session_failed' } });
    expect(JSON.stringify(result)).toContain('-32600');
    expect(JSON.stringify(result)).toContain('invalid request');
    expect(h.agent.unstable_forkSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(h.agent.loadSession).not.toHaveBeenCalled();
  });

  it('maps ACP auth_required JSON-RPC errors to auth_required', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockRejectedValueOnce({ code: -32000, message: 'Authentication required' });

    const result = await rt.startSession(makeStartInput({ sessionId: 'conv-auth-required' }));

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.type).toBe('auth_required');
  });

  it('gives each conversation its own process and releases it on stop', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' });

    await rt.startSession(makeStartInput({ sessionId: 'conv-a', workspaceId: 'ws-1' }));
    await rt.startSession(makeStartInput({ sessionId: 'conv-b', workspaceId: 'ws-1' }));

    expect(h.children).toHaveLength(2);
    await rt.stopSession('conv-a');
    expect(h.children[0]?.kill).toHaveBeenCalledWith('SIGTERM');
    await rt.stopSession('conv-b');
    await until('conv-b adapter receives SIGTERM', () =>
      h.children[1]?.kill.mock.calls.some(([signal]) => signal === 'SIGTERM') ?? false);
    expect(h.children[1]?.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('isolates every adapter by conversation regardless of credential source', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' });

    await Promise.all([
      rt.startSession(
        makeStartInput({ sessionId: 'platform-a', platform: platformInjection() })
      ),
      rt.startSession(
        makeStartInput({ sessionId: 'platform-b', platform: platformInjection() })
      ),
    ]);

    expect(h.children).toHaveLength(2);
  });

  it('deduplicates overlapping starts for the same platform conversation', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    let resolveSession!: (value: { sessionId: string }) => void;
    h.agent.newSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        })
    );
    const input = makeStartInput({
      sessionId: 'platform-overlap',
      platform: platformInjection(),
    });

    const first = rt.startSession(input);
    const second = rt.startSession(input);
    await h.agent.called('newSession');
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    resolveSession({ sessionId: 'shared-session' });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { success: true, data: { providerSessionId: 'shared-session' } },
      { success: true, data: { providerSessionId: 'shared-session' } },
    ]);
    expect(h.children).toHaveLength(1);
  });

  it('clears a failed start so the same conversation can be retried', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockRejectedValueOnce(new Error('first start failed'))
      .mockResolvedValueOnce({ sessionId: 'retry-session' });
    const input = makeStartInput({ sessionId: 'retry-start' });

    await expect(rt.startSession(input)).resolves.toMatchObject({ success: false });
    await expect(rt.startSession(input)).resolves.toEqual({
      success: true,
      data: { providerSessionId: 'retry-session' },
    });
  });

  it('notifies once when a platform session stops', async () => {
    const onPlatformSessionClosed = vi.fn();
    const h = makeAcpHarness({ onPlatformSessionClosed });
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(
      makeStartInput({
        sessionId: 'platform-stop',
        platform: platformInjection(),
        platformAccessSessionId: 'access-stop',
      })
    );

    await rt.stopSession('platform-stop');

    expect(onPlatformSessionClosed).toHaveBeenCalledTimes(1);
    expect(onPlatformSessionClosed).toHaveBeenCalledWith('platform-stop', 'access-stop');
  });

  // #4467 —— 会话级凭据方言(claude:平台凭据走 `_meta`,不带进程级 `platform` 载荷)同样要报。
  // 运行时不知道宿主有没有为这条会话签令牌,也不该猜:从前拿 `input.platform` 当代理,claude 的会话
  // 关闭时这条通知从不发出 ⇒ 宿主那份带令牌的 0600 文档留在盘上、结清永不发生(真机实测)。
  it('notifies on stop even when the session carried no process-level platform payload', async () => {
    const onPlatformSessionClosed = vi.fn();
    const h = makeAcpHarness({ onPlatformSessionClosed });
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'session-meta-stop',
      platformAccessSessionId: 'access-session-meta',
    }));

    await rt.stopSession('session-meta-stop');

    expect(onPlatformSessionClosed).toHaveBeenCalledWith(
      'session-meta-stop',
      'access-session-meta',
    );
  });

  it('notifies when a private platform adapter exits', async () => {
    let reportClosed!: () => void;
    const closedReported = new Promise<void>((resolve) => (reportClosed = resolve));
    const onPlatformSessionClosed = vi.fn(() => reportClosed());
    const h = makeAcpHarness({ onPlatformSessionClosed });
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(
      makeStartInput({
        sessionId: 'platform-exit',
        platform: platformInjection(),
        platformAccessSessionId: 'access-exit',
      })
    );

    h.lastChild.emitExit(9);

    await closedReported;
    expect(onPlatformSessionClosed).toHaveBeenCalledTimes(1);
    expect(onPlatformSessionClosed).toHaveBeenCalledWith('platform-exit', 'access-exit');
  });

  it('keeps a session managed when provider close fails so stop can be retried', async () => {
    const { h, rt, sessionId } = await startHarness('conv-close-failure');
    h.agent.closeSession.mockRejectedValueOnce(new Error('provider refused close'));

    const failed = await rt.stopSession(sessionId);
    expect(failed).toEqual(
      expect.objectContaining({ success: false, error: expect.objectContaining({ type: 'stop_failed' }) })
    );
    expect(rt.sessionLiveModels(sessionId)).toBeDefined();

    await expect(rt.stopSession(sessionId)).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(rt.sessionLiveModels(sessionId)).toBeNull();
  });

  it('uses host teardown when ACP provider does not implement session/close', async () => {
    const { h, rt, sessionId } = await startHarness('conv-close-unsupported');
    h.agent.closeSession.mockRejectedValueOnce(new Error('"Method not found": session/close'));

    await expect(rt.stopSession(sessionId)).resolves.toEqual({
      success: true,
      data: undefined,
    });
    expect(rt.sessionLiveModels(sessionId)).toBeNull();
  });

  it('publishes activeTurn patches without root replacement during incremental text growth', async () => {
    const { h, rt, client, providerSessionId } = await startHarness('conv-live');
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt = vi.fn(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          resolvePrompt = resolve;
        })
    );
    const live = rt.sessionLiveModels('conv-live');
    if (!live) throw new Error('expected live models');
    const updates: Array<{ delta: unknown }> = [];
    const unsubscribe = live.states.activeTurn.subscribe((update) => updates.push(update));

    const prompt = rt.sendPrompt('conv-live', { text: 'hello' });
    updates.length = 0;
    await client.sessionUpdate({
      sessionId: providerSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        sessionId: providerSessionId,
        messageId: 'msg-1',
        content: { type: 'text', text: 'hel' },
      } as SessionUpdate,
    });
    updates.length = 0;
    await client.sessionUpdate({
      sessionId: providerSessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        sessionId: providerSessionId,
        messageId: 'msg-1',
        content: { type: 'text', text: 'lo' },
      } as SessionUpdate,
    });

    const patches = updates.flatMap((update) => update.delta as Array<{ path: unknown[] }>);
    expect(patches.length).toBeGreaterThan(0);
    expect(patches.every((patch) => patch.path.length > 0)).toBe(true);
    unsubscribe();
    resolvePrompt({ stopReason: 'end_turn' });
    await prompt;
  });

  it('publishes usage updates through live models', async () => {
    const { rt, client, providerSessionId } = await startHarness('conv-usage');
    const live = rt.sessionLiveModels('conv-usage');
    if (!live) throw new Error('expected live models');
    const updates: unknown[] = [];
    const unsubscribe = live.states.usage.subscribe((update) => updates.push(update));

    await client.sessionUpdate({
      sessionId: providerSessionId,
      update: {
        sessionUpdate: 'usage_update',
        sessionId: providerSessionId,
        used: 42_000,
        size: 200_000,
        cost: { amount: 0.25, currency: 'USD' },
      } as SessionUpdate,
    });

    expect(live.states.usage.snapshot().data).toEqual({
      contextUsed: 42_000,
      contextSize: 200_000,
      cost: { amount: 0.25, currency: 'USD' },
    });
    expect(updates.length).toBeGreaterThan(0);
    // L12: the conversation summary carries the same number (an App's listAgents reads it there).
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-usage']?.contextTokens).toBe(42_000);
    unsubscribe();
  });

  it('keeps stored attachment ids in user transcript messages', async () => {
    const resolveAttachment = vi.fn().mockResolvedValue({
      data: 'base64-image',
      mimeType: 'image/png',
    });
    const h = makeAcpHarness({ resolveAttachment });
    const rt = new AcpRuntime(h.deps);
    const started = await rt.startSession(makeStartInput({ sessionId: 'conv-attachment' }));
    expect(isOk(started)).toBe(true);

    const sent = await rt.sendPrompt('conv-attachment', {
      text: 'look',
      attachments: [
        {
          type: 'attachment',
          id: 'attachment-1',
          name: 'image.png',
          mimeType: 'image/png',
        },
      ],
    });

    expect(isOk(sent)).toBe(true);
    expect(resolveAttachment).toHaveBeenCalledWith({
      type: 'attachment',
      id: 'attachment-1',
      name: 'image.png',
      mimeType: 'image/png',
    });
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        { type: 'text', text: 'look' },
      ],
    });

    const history = rt.getHistory('conv-attachment');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'look',
      attachments: [{ id: 'attachment-1', name: 'image.png', mimeType: 'image/png' }],
    });
  });

  it('sends hidden prompt context to the agent without adding it to the transcript', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const started = await rt.startSession(
      makeStartInput({ sessionId: 'conv-hidden-context' })
    );
    expect(isOk(started)).toBe(true);

    const sent = await rt.sendPrompt('conv-hidden-context', {
      text: 'Fix @[ENG-123](issue:linear:ENG-123)',
      hiddenContext: '<issue_context identifier="ENG-123">Context body</issue_context>',
    });

    expect(isOk(sent)).toBe(true);
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'Fix @[ENG-123](issue:linear:ENG-123)' },
        { type: 'text', text: '<issue_context identifier="ENG-123">Context body</issue_context>' },
      ],
    });

    const history = rt.getHistory('conv-hidden-context');
    expect(isOk(history)).toBe(true);
    if (!isOk(history)) return;
    expect(history.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'Fix @[ENG-123](issue:linear:ENG-123)',
    });
    expect(JSON.stringify(history.data.turns[0].items[0])).not.toContain('Context body');
  });

  it('系统提示词走 _meta 系统通道，绝不出现在用户 prompt 里', async () => {
    // @@@system-prompt-channel —— 用户消息在 wire 上仍是一条普通消息。
    // 旧行为把平台块挂在 prompt 的 hiddenContext 上，于是 content 变成
    //   [ {text:'first'}, {text:'<gugu_platform>…'} ]
    // 用户消息因此不再是普通消息，任何按「一条消息」读取的地方都认不出它。
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'conv-session-prompt',
      sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
    }));

    // ① 块必须在 session/new 的系统信封里
    expect(h.agent.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({
          systemPrompt: { append: '<gugu_platform>Resident context</gugu_platform>' },
        }),
      })
    );

    await rt.sendPrompt('conv-session-prompt', {
      text: 'first',
      hiddenContext: '<issue_context>Issue body</issue_context>',
    });
    await rt.sendPrompt('conv-session-prompt', { text: 'second' });

    // ② 首条 prompt 只带用户自己的东西 —— 用户的 hiddenContext 是【这条消息】的上下文，正当保留
    expect(h.agent.prompt).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: 'first' },
        { type: 'text', text: '<issue_context>Issue body</issue_context>' },
      ],
    });
    expect(h.agent.prompt).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'second' }],
    });

    // ③ 任何一条 prompt 都不得夹带平台块（变异时这一条最先红）
    for (const [, req] of (h.agent.prompt as ReturnType<typeof vi.fn>).mock.calls.entries()) {
      expect(JSON.stringify(req)).not.toContain('gugu_platform');
    }
    expect(JSON.stringify(rt.getHistory('conv-session-prompt'))).not.toContain('Resident context');
  });

  it('③ 没有系统位的家：平台块走用户级载体进首轮，且**绝不**进 _meta', async () => {
    // behavior `agent-context-injection` 的 ③。同一段字节只去一个地方 —— 进了 _meta 又进首轮
    // = 一场会话里说两遍;两边都不进 = 静默没送到。路由位就是为了让这件事只有一种可能。
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'conv-session-context',
      sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
      sessionPromptCarrier: 'session-context',
    }));

    // ① 系统信封里**不许**有它 —— 这家根本没有系统位,放进去就是丢进黑洞。
    const newSessionArg = (h.agent.newSession as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(JSON.stringify(newSessionArg ?? {})).not.toContain('Resident context');

    await rt.sendPrompt('conv-session-context', { text: 'first' });
    await rt.sendPrompt('conv-session-context', { text: 'second' });

    // ② 它在**第一次真正发出去的那一轮**里,排在用户这一句之前(它是常驻背景)。
    expect(h.agent.prompt).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      prompt: [
        { type: 'text', text: '<gugu_platform>Resident context</gugu_platform>' },
        { type: 'text', text: 'first' },
      ],
    });

    // ③ **只说一次** —— 它是会话级的。每轮重发 = 每一轮都重付一遍注入成本。
    expect(h.agent.prompt).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'second' }],
    });

    // ④ 不进转录:它的身份是系统提示词,用户看不见。
    expect(JSON.stringify(rt.getHistory('conv-session-context'))).not.toContain('Resident context');
  });

  it('③ 的路由位缺席时回落系统位 —— 既有的家一个字都不用改', async () => {
    // 阴性对照:上面那条若在**不带 carrier** 时也绿,说明它判的不是 carrier 而是别的东西。
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'conv-default-carrier',
      sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
    }));
    await rt.sendPrompt('conv-default-carrier', { text: 'first' });

    // 缺省 = 系统位:进 _meta、不进 prompt。与带 carrier 那条恰好相反。
    expect(h.agent.newSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({
          systemPrompt: { append: '<gugu_platform>Resident context</gugu_platform>' },
        }),
      })
    );
    expect(h.agent.prompt).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'first' }],
    });
  });

  it('重开会话同样经系统通道带上平台块 —— 而不是"不再发"', async () => {
    // 旧行为是 resume 时干脆不发（因为发就得塞进用户消息）。系统通道没有这个两难：
    // 信封本来就该每次带全，漏掉它 = 重开后的 agent 没有平台自述，且只在重开时发作。
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => ({}));
    const rt = new AcpRuntime(h.deps);
    await rt.resumeSession({
      ...makeStartInput({
        sessionId: 'conv-resumed-session-prompt',
        sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
      }),
      providerSessionId: 'session-old',
    });

    expect(h.agent.loadSession).toHaveBeenCalledWith(
      expect.objectContaining({
        _meta: expect.objectContaining({
          systemPrompt: { append: '<gugu_platform>Resident context</gugu_platform>' },
        }),
      })
    );

    await rt.sendPrompt('conv-resumed-session-prompt', { text: 'after resume' });
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-old',
      prompt: [{ type: 'text', text: 'after resume' }],
    });
  });

  it('fails loud without session/new when the provider says the saved session is missing', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => {
      throw {
        code: -32600,
        message: 'no rollout found for thread id 019ff4fc-1e4b-7a20-a24a-353f95aa51b6',
      };
    });
    const rt = new AcpRuntime(h.deps);

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-missing-provider-session' }),
      providerSessionId: '019ff4fc-1e4b-7a20-a24a-353f95aa51b6',
    });

    expect(result).toEqual({
      success: false,
      error: expect.objectContaining({ type: 'provider_session_missing' }),
    });
    expect(h.agent.newSession).not.toHaveBeenCalled();
  });

  // 这条用例原先钉的是相反的合同:「a generic resume fails without falling back to a new
  // provider session」—— load 失败就抛,屏幕上只剩「Failed to load chat」加一个重试按钮。
  // owner 2026-09-13 裁决:「不可能打不开,打不开是 bug 级别的问题,基本代表产品不可用」。
  // #5553 自己也量到那个 Retry 在这种失败下**永远不会成功**(provider 那侧确实不在了)。
  // ⇒ 会话必须打得开:退回 `session/new`,本机那份历史照常上屏,并在开头画一条界说明
  // 「往上的内容引擎没有」。降级是**看得见**的,不是悄悄换 —— 这正是原合同担心的那一点。
  it('a generic resume falls back to a new provider session instead of failing to open', async () => {
    const h = makeAcpHarness();
    h.agent.loadSession = vi.fn(async () => {
      throw new Error('provider history unavailable');
    });
    const rt = new AcpRuntime(h.deps);
    const result = await rt.resumeSession({
      ...makeStartInput({
        sessionId: 'conv-resume-fallback-prompt',
        sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
      }),
      providerSessionId: 'session-old',
    });

    expect(result).toMatchObject({ success: true });
    expect(h.agent.newSession).toHaveBeenCalled();
  });

  it('exports session-new diagnostics without MCP secrets or process configuration', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    const modes = {
      currentModeId: 'agent',
      availableModes: [
        { id: 'agent', name: 'Agent' },
        { id: 'agent-full-access', name: 'Agent (full access)' },
      ],
    };
    const configOptions = modeConfigOptions('agent');
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-secret-boundary',
      modes,
      configOptions,
    });

    const started = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-secret-boundary',
        mcpServers: [
          {
            type: 'http',
            name: 'gugu',
            url: 'http://127.0.0.1:43120/private-mcp-path',
            headers: [{ name: 'Authorization', value: 'Bearer raw-log-secret-value' }],
          },
        ],
      })
    );
    expect(isOk(started)).toBe(true);

    const exported = rt.exportRawAcpLog('conv-secret-boundary');
    expect(isOk(exported)).toBe(true);
    if (!isOk(exported)) return;
    const raw = JSON.parse(exported.data) as {
      events: Array<{ event: { kind: string } & Record<string, unknown> }>;
    };
    const sessionNew = raw.events.find((entry) => entry.event.kind === 'session_new');
    expect(sessionNew?.event).toEqual({
      kind: 'session_new',
      sessionId: 'session-secret-boundary',
      request: { cwd: '/tmp/workspace', mcpServerNames: ['gugu'] },
      response: {
        sessionId: 'session-secret-boundary',
        modes,
        configOptions,
      },
    });
    expect(exported.data).not.toContain('raw-log-secret-value');
    expect(exported.data).not.toContain('Authorization');
    expect(exported.data).not.toContain('/private-mcp-path');
  });

  /**
   * #5143 —— agent 在 `session/new` 刚返回就推的通知**必须收得到**。
   *
   * 真实形状:`claude-agent-acp` 在 newSession 返回后立刻 `setTimeout(0)` 发
   * `available_commands_update`。而 `session/new` 这条路要等模型/档位/初始队列都摆完
   * 才 `registerRoute`,中间还隔着一次真的 `setSessionConfigOption` 往返 ⇒ 那段时间里
   * `onSessionUpdate` 解不出 conversationId,把它丢了。产品面表现:**新建的会话 `/` 面板
   * 是空的,重开的却是满的**(`session/load` 在调用之前就登记了路由)。
   *
   * 判据用 raw ACP log:被丢弃时 `onSessionUpdate` 在 `recordRaw` **之前**就 return 了,
   * 所以「日志里有没有这条」正好把「收到了」与「被丢了」分开。
   */
  it('#5143 keeps a session update that arrives before session/new finishes wiring up', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    // 通知必须落在**真实的那扇窗**里:`newSession` 已经返回(sessionId 已知),而宿主还在
    // 往下摆模型/档位/初始队列。挂在 setSessionConfigOption 上正好是那一刻 ——
    // ❌ 不能在 newSession 的 mock 体里发:那是 sessionId 还没交出来之前,任何实现都接不住,
    //    那样的用例测的是一个不可能满足的条件,不是这个 bug。
    const modelOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model' as const,
        type: 'select' as const,
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Sonnet' }, { value: 'opus', name: 'Opus' }],
      },
    ];
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-1',
      configOptions: modelOptions,
    });
    h.agent.setSessionConfigOption = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'deep-research', description: 'probe', input: null }],
        } as unknown as SessionUpdate,
      });
      return { configOptions: modelOptions };
    });

    const result = await rt.startSession(
      makeStartInput({ sessionId: 'conv-early', model: 'opus' })
    );
    expect(isOk(result)).toBe(true);

    const exported = rt.exportRawAcpLog('conv-early');
    expect(isOk(exported)).toBe(true);
    if (!isOk(exported)) return;
    expect(exported.data).toContain('available_commands_update');
    expect(exported.data).toContain('deep-research');
  });

  /**
   * 阴控:判据必须还能红。一条**真的**不属于任何已知会话的通知仍然要被丢掉 ——
   * 否则上面那条会被一个「什么都往里记」的实现满足。
   */
  it('#5143 still drops an update whose session belongs to nobody', async () => {
    const { h, rt } = await startHarness('conv-known');
    await h.client().sessionUpdate({
      sessionId: 'session-from-nowhere',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'ghost-command', description: 'x', input: null }],
      } as unknown as SessionUpdate,
    });

    const exported = rt.exportRawAcpLog('conv-known');
    expect(isOk(exported)).toBe(true);
    if (!isOk(exported)) return;
    expect(exported.data).not.toContain('ghost-command');
  });

  it('returns a resume result with replayed history', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-old',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 'session-old',
          messageId: 'msg-1',
          content: { type: 'text', text: 'from history' },
        } as SessionUpdate,
      });
      return {};
    });

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-resume' }),
      providerSessionId: 'session-old',
    });

    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.data.providerSessionId).toBe('session-old');
    expect(result.data.turns).toHaveLength(1);
    expect(result.data.turns[0].items[0]).toMatchObject({
      kind: 'message',
      text: 'from history',
    });
  });

  // spec session-history-replay(#5381):历史由会话页自己持久化,重放降为「恢复上下文 + 补缺」。
  //
  // 落盘方要如实知道每一回合**从哪来**,因为两者的处置相反:重放回来的那一段在库里通常已经有了
  // (库里那份完整,重放只含压缩边界之后的一截),再写一遍就是让用户看见自己说过的话重复出现。
  // 标错的代价不对称,所以两个方向各断言一次。
  it('#5381 回合来源:重放期间标 replay,重放之后真正说的标 live', async () => {
    const committed: Array<{ source: string; text: string }> = [];
    const h = makeAcpHarness({
      onTurnCommitted: ({ source, turn }) => {
        const item = turn.items.find((entry) => entry.kind === 'message');
        committed.push({
          source,
          text: item && 'text' in item ? String((item as { text: unknown }).text) : '',
        });
      },
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-old',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 'session-old',
          messageId: 'msg-history',
          content: { type: 'text', text: '压缩前说过的' },
        } as SessionUpdate,
      });
      return {};
    });

    const resumed = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-turn-source' }),
      providerSessionId: 'session-old',
    });
    expect(isOk(resumed)).toBe(true);

    // ⚠️ 这一条守的是 `endReplay()` 的时序陷阱:它**先**把状态机切出 replaying、**后**才发
    // transcript 变更。所以重放窗口只能由 begin/end 的调用方自己持有 —— 去问状态机的 phase
    // 会把重放回来的最后一回合报成 live,而那正是最容易被写重的一回合。
    expect(committed).toEqual([{ source: 'replay', text: '压缩前说过的' }]);

    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt = vi.fn(
      () =>
        new Promise<{ stopReason: 'end_turn' }>((resolve) => {
          resolvePrompt = resolve;
        })
    );
    const prompt = rt.sendPrompt('conv-turn-source', { text: '重启之后说的' });
    await h.client().sessionUpdate({
      sessionId: 'session-old',
      update: {
        sessionUpdate: 'agent_message_chunk',
        sessionId: 'session-old',
        messageId: 'msg-live',
        content: { type: 'text', text: '刚说的' },
      } as SessionUpdate,
    });
    resolvePrompt({ stopReason: 'end_turn' });
    await prompt;

    // 重放之后这一回合必须是 live。它同时是水位那条规则的阳控:重放会把已提交列表整份清空重建,
    // 水位若只增不减,这一回合会被当成「早推过了」而永远不落盘 —— 症状是「重启一次之后说的话
    // 全不见了」,比原来的毛病更坏。
    expect(committed.map((entry) => entry.source)).toEqual(['replay', 'live']);
  });

  // 侧边对话由**运行时分叉**实现,它的 conversationId 是个视图 id —— 库里没有这一行。
  // 落盘会当场撞外键;而且它本来就不该有自己的历史:上下文开在主对话那条上,
  // 侧边这条不展示更多。判据与 `publishSummary` 里那道闸同源:`sourceConversationId`。
  it('#5381 侧边对话(运行时视图)的回合不落盘', async () => {
    const committed: string[] = [];
    const h = makeAcpHarness({
      onTurnCommitted: ({ sessionId }) => committed.push(sessionId),
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-main',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 'session-main',
          messageId: 'msg-side',
          content: { type: 'text', text: '侧边这条说的' },
        } as SessionUpdate,
      });
      return {};
    });

    const resumed = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'view-side-1' }),
      // 这一项就是「我是运行时视图」的判据本身。
      sourceSessionId: 'conv-main',
      providerSessionId: 'session-main',
    });

    expect(isOk(resumed)).toBe(true);
    expect(committed).toEqual([]);
  });

  it('carries the platform envelope on session/new AND on the reopen path', async () => {
    // 信封里是这条会话的中转地址与令牌。session/new 那一半漏了,首轮就打不通,一眼看得见;
    // **loadSession 这一半漏了,首轮完全正常、只在重开时发作** —— 适配器的 loadSession 把 `_meta`
    // 转给它内部的 createSession,新起的 claude 进程完全靠这份信封才知道打哪个中转。没有它就退回
    // 用户自己的 settings:界面上这条会话还写着咕咕的模型,请求却打到用户的网关,而积分早已按平台
    // 会话预留。所以两条路各断言一次。
    const sessionMeta = {
      claudeCode: { options: { settings: '/tmp/gugu-settings.json', env: { ANTHROPIC_BASE_URL: 'https://relay.example' } } },
    };
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);

    await rt.startSession(makeStartInput({ sessionId: 'conv-meta-new', sessionMeta }));
    expect(h.agent.newSession).toHaveBeenCalledWith(expect.objectContaining({ _meta: sessionMeta }));

    h.agent.loadSession = vi.fn(async () => ({}));
    await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-meta-load', sessionMeta }),
      providerSessionId: 'session-old',
    });
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({ _meta: sessionMeta }));
  });

  it('adds no envelope to a session that is not on platform quota', async () => {
    // BYOK / 默认会话的请求必须与从前逐字节相同 —— 平白多一个 `_meta` 键是在替用户改他自己的会话。
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);

    await rt.startSession(makeStartInput({ sessionId: 'conv-no-meta' }));

    expect(h.agent.newSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ _meta: expect.anything() })
    );
  });

  it('applies configured permission mode before the first prompt for new and resumed sessions', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported' });
    const rt = new AcpRuntime(h.deps);
    const order: string[] = [];
    let finishMode!: () => void;
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-new',
      configOptions: modeConfigOptions('agent'),
    });
    h.agent.setSessionConfigOption.mockImplementationOnce(async () => {
      order.push('mode:start');
      await new Promise<void>((resolve) => {
        finishMode = resolve;
      });
      order.push('mode:end');
      return { configOptions: modeConfigOptions('agent-full-access') };
    });
    h.agent.prompt.mockImplementationOnce(async () => {
      order.push('prompt');
      return { stopReason: 'end_turn' };
    });

    const starting = rt.startSession(
      makeStartInput({
        sessionId: 'conv-new-mode',
        permissionMode: 'full-access',
        initialQueue: [{ text: 'first prompt', origin: 'manual' }],
      })
    );
    await h.agent.called('setSessionConfigOption');
    expect(order).toEqual(['mode:start']);
    expect(h.agent.prompt).not.toHaveBeenCalled();
    finishMode();
    expect(isOk(await starting)).toBe(true);
    await h.agent.called('prompt');
    expect(order).toEqual(['mode:start', 'mode:end', 'prompt']);

    h.agent.loadSession.mockResolvedValueOnce({
      configOptions: modeConfigOptions('agent'),
    });
    const resumeOrder: string[] = [];
    let finishResumeMode!: () => void;
    h.agent.setSessionConfigOption.mockImplementationOnce(async () => {
      resumeOrder.push('mode:start');
      await new Promise<void>((resolve) => {
        finishResumeMode = resolve;
      });
      resumeOrder.push('mode:end');
      return { configOptions: modeConfigOptions('agent-full-access') };
    });
    h.agent.prompt.mockImplementationOnce(async () => {
      resumeOrder.push('prompt');
      return { stopReason: 'end_turn' };
    });
    h.agent.setSessionConfigOption.mockClear();
    h.agent.prompt.mockClear();
    const resumed = rt.resumeSession({
      ...makeStartInput({
        sessionId: 'conv-resumed-mode',
        permissionMode: 'full-access',
        initialQueue: [{ text: 'resumed prompt', origin: 'manual' }],
      }),
      providerSessionId: 'session-existing',
    });

    await h.agent.called('setSessionConfigOption');
    expect(resumeOrder).toEqual(['mode:start']);
    expect(h.agent.prompt).not.toHaveBeenCalled();
    finishResumeMode();
    expect(isOk(await resumed)).toBe(true);
    await h.agent.called('prompt');
    expect(resumeOrder).toEqual(['mode:start', 'mode:end', 'prompt']);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-existing',
      configId: 'mode',
      value: 'agent-full-access',
    });
    expect(
      rt.sessionLiveModels('conv-resumed-mode')?.states.config.snapshot().data.modeOptions?.selected
    ).toBe('agent-full-access');
  });

  // 切档失败之后会话停在哪一档没有读数。**更严的档**下这个未知就是越权风险 ⇒ 响亮失败。
  it('fails session creation before prompting when a restrictive permission mode cannot be applied', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-mode-failure',
      configOptions: codexThreeModeConfigOptions(':danger-full-access'),
    });
    h.agent.setSessionConfigOption.mockRejectedValueOnce(new Error('mode rejected'));

    const result = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-mode-failure',
        initialQueue: [{ text: 'must not run', origin: 'manual' }],
      }),
      permissionMode: 'read-only',
    });

    expect(result).toMatchObject({ success: false, error: { type: 'initialize_failed' } });
    expect(h.agent.prompt).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('conv-mode-failure')).toBeNull();
  });

  // 同一个失败,**阶梯顶端**下的答案相反:未知的那一档也不可能比完全访问更松 ⇒ 会话照常开。
  // owner 2026-09-05:「我不想失败不行吗」——这一档下咕咕不因为档位问题拒绝开会话。
  it('切档失败时,选了完全访问仍把会话开起来', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-mode-failure-full',
      configOptions: modeConfigOptions('agent'),
    });
    h.agent.setSessionConfigOption.mockRejectedValueOnce(new Error('mode rejected'));

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-mode-failure-full',
        permissionMode: 'full-access',
        initialQueue: [{ text: 'must run', origin: 'manual' }],
      })
    );

    expect(isOk(result)).toBe(true);
    expect(rt.sessionLiveModels('conv-mode-failure-full')).not.toBeNull();
  });

  function modelConfigOptions(selected: string) {
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'gpt-5.5', name: 'GPT-5.5' },
          { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
        ],
      },
    ];
  }

  /**
   * #5047 —— 咕咕的 codex 桥在 session/new 只报 mode 一档、没有 model 维度,composer 预选的模型无处可落。
   *
   * 这条 case 的行为改过两次,两次都是为了同一个不变量「**界面显示的模型 == 实际在跑的模型**」:
   * - 最早:记一条 warn 放行 ⇒ 会话跑在 provider 默认模型上、界面却显示所选那一个。**静默说谎**,
   *   用户能看到的只有一轮永不回答的 Working。
   * - #5047:改成启动失败。谎是不说了,代价是**整条会话打不开**。
   * - 现在(owner 2026-09-19「任何 bug 都不应该让会话打不开」):会话照常开,转录里一行说清
   *   「你选的那个落不下去,现在跑的是引擎自己的默认」。⇒ 不变量由**说实话**来守,不是由杀会话来守。
   *
   * 首句照常发出去:行已经把真相摆在那儿了,而把它扣住只会造出一个新的「打不开」状态
   * (spec `session-always-openable`)。
   */
  it('opens the session on the provider default, with a notice, when it exposes no way to apply the chosen model', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-no-model-dimension',
      configOptions: modeConfigOptions('agent'),
    });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-model-unappliable',
        model: 'gpt-5.5',
        initialQueue: [{ text: 'must not run', origin: 'manual' }],
      })
    );

    expect(isOk(result)).toBe(true);
    const history = JSON.stringify(rt.getChatHistory('conv-model-unappliable'));
    expect(history).toContain('session-notice');
    expect(history).toContain('model-unavailable');
    // provider 自己的原话必须留在行里 —— 「截断与失败都要留下可诊断的痕迹」。
    expect(history).toContain('does not expose model configuration');
    expect(history).toContain('gpt-5.5');
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('conv-model-unappliable')).not.toBeNull();
  });

  it('opens the session with the provider\'s own reason on the notice row when it rejects the chosen model id', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-model-rejected',
      configOptions: modelConfigOptions('gpt-5.4-mini'),
    });
    h.agent.setSessionConfigOption.mockRejectedValueOnce(new Error('unknown model: gpt-9'));

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-model-rejected',
        model: 'gpt-9',
        initialQueue: [{ text: 'must not run', origin: 'manual' }],
      })
    );

    expect(isOk(result)).toBe(true);
    const history = JSON.stringify(rt.getChatHistory('conv-model-rejected'));
    expect(history).toContain('model-unavailable');
    expect(history).toContain('unknown model: gpt-9');
    // 「现在跑的是什么」取自 provider 自己报的那份目录,❌ 不猜。
    expect(history).toContain('gpt-5.4-mini');
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-model-rejected',
      configId: 'model',
      value: 'gpt-9',
    });
    expect(rt.sessionLiveModels('conv-model-rejected')).not.toBeNull();
  });

  it('explains when Claude user availableModels excludes the selected platform model', async () => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.resolveAcp('claude');
    if (!provider) throw new Error('test provider missing'); provider.behavior.explainError = () => '你的 ~/.claude/settings.json availableModels 排除了该模型。';
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-claude-model-rejected',
      configOptions: modelConfigOptions('claude-sonnet-4-6'),
    });
    h.agent.setSessionConfigOption.mockRejectedValueOnce(
      new Error('Invalid value for config option model: gpt-5.6-sol')
    );

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-claude-model-rejected',
        providerId: 'claude',
        model: 'gpt-5.6-sol',
      })
    );

    expect(isOk(result)).toBe(true);
    // 那句解释是这条行唯一能让用户自己修好问题的线索 —— 它必须跟着进 detail。
    expect(JSON.stringify(rt.getChatHistory('conv-claude-model-rejected')))
      .toContain('你的 ~/.claude/settings.json availableModels 排除了该模型');
  });

  // 「维度缺席」在 provider 已经有的那条会话上**不是**失败读数:它带着自己创建时的模型,咕咕只是
  // 没法再断言一次。为它拒绝重开 = 拿一个从没与我们分歧过的读数弄坏一条好会话(真机对照:claude
  // 在 load 时照报模型维度、原样重开;咕咕的 codex 桥一次都不报,#5050)。
  it('resumes an existing provider session that exposes no model dimension instead of refusing to reopen it', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: modeConfigOptions('agent') });

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-resume-no-dimension', model: 'gpt-5.5' }),
      providerSessionId: 'session-existing',
    });

    expect(isOk(result)).toBe(true);
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    // 维度不在 ⇒ 一次调用都不该发出去(发了就是拿一个 provider 不认的 configId 去撞它)。
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('conv-resume-no-dimension')).not.toBeNull();
  });

  // 同一条重开路上,provider **明确拒了这个 id**:那是对这个模型的活拒绝,换成新会话也一样拒。
  // ⇒ ❌ 不回落成 session/new 再演一遍(那会丢掉 provider 侧的上文),也 ❌ 不把这条会话判死 ——
  //    重开成功、历史还在、转录里一行说清模型的事(spec `session-always-openable`)。
  it('resumes without falling back to session/new when the provider rejects the model id', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: modelConfigOptions('gpt-5.4-mini') });
    h.agent.setSessionConfigOption.mockRejectedValueOnce(new Error('unknown model: gpt-9'));

    const result = await rt.resumeSession({
      ...makeStartInput({ sessionId: 'conv-resume-rejected', model: 'gpt-9' }),
      providerSessionId: 'session-existing',
    });

    expect(isOk(result)).toBe(true);
    expect(JSON.stringify(rt.getChatHistory('conv-resume-rejected'))).toContain('unknown model: gpt-9');
    expect(h.agent.loadSession).toHaveBeenCalledTimes(1);
    expect(h.agent.newSession).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('conv-resume-rejected')).not.toBeNull();
  });

  // fork 与 resume 同一条规则(此前 fork 分支根本不碰模型):分叉出来的会话是 provider 已经有的,
  // 维度缺席照常开,❌ 不为一个断言不了的事实把侧边聊天判死。
  it('forks an existing provider session that exposes no model dimension', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {} } },
    });
    h.agent.unstable_forkSession.mockResolvedValueOnce({ sessionId: 'forked-session' });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'side-chat:model-view',
        sourceSessionId: 'source-conversation',
        forkFromProviderSessionId: 'source-session',
        model: 'gpt-5.5',
      })
    );

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
    expect(rt.sessionLiveModels('side-chat:model-view')).not.toBeNull();
  });

  // 阳控:provider 报得出 model 维度时,所选模型在首句之前落地,会话照常起来。
  it('applies the chosen model before the first prompt when the provider exposes the model dimension', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-model-ok',
      configOptions: modelConfigOptions('gpt-5.4-mini'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: modelConfigOptions('gpt-5.5'),
    });

    const result = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-model-ok',
        model: 'gpt-5.5',
        initialQueue: [{ text: 'first prompt', origin: 'manual' }],
      })
    );

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-model-ok',
      configId: 'model',
      value: 'gpt-5.5',
    });
    expect(
      rt.sessionLiveModels('conv-model-ok')?.states.config.snapshot().data.modelOptions?.selected
    ).toBe('gpt-5.5');
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
  });

  // #6183 ②: 起不来的会话是一个终态,不是「消失」。状态投影把 lost 读成 error。
  it('publishes a failed start as a lost summary carrying the structured error', async () => {
    const h = makeAcpHarness();
    h.agent.initialize = vi.fn(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);

    const pending = rt.startSession(makeStartInput({ sessionId: 'conv-init-exit' }));
    await h.agent.called('initialize');
    h.lastChild.emitExit(1);
    const result = await pending;

    expect(result).toMatchObject({ success: false, error: { type: 'initialize_failed' } });
    const summary = rt.sessionsListLiveModel().states.list.snapshot().data['conv-init-exit'];
    expect(summary?.lifecycle).toBe('lost');
    expect(summary?.failure).toMatchObject({
      kind: 'start-failed',
      error: { type: 'initialize_failed', cause: { message: expect.stringContaining('code 1') } },
    });
    expect(summary?.failure?.message).toMatch(/^Start failed while waiting for the engine to initialize/);
    expect(summary?.failure?.message).toContain('exited before initialize completed');
    expect(rt.sessionLiveModels('conv-init-exit')).toBeNull();
  });

  // #6183 阴控:`--version` 永远不退出(卡在交互提示 / 等 stdin)。会话必须停在看得见的
  // 「检查可执行文件」这一步,能取消,取消后的原因写明卡在这一步 —— ❌ 永远 starting、❌ 无声。
  it('a version probe that never exits stays visible as checking-executable and cancels with that step', async () => {
    const h = makeAcpHarness();
    let probeStarted!: () => void;
    const probing = new Promise<void>((resolve) => (probeStarted = resolve));
    const buildAcpSpawn = vi.spyOn(h.deps.agentHost, 'buildAcpSpawn').mockImplementation(
      (_providerId, ctx) =>
        new Promise((resolve) => {
          probeStarted();
          // 探针只在被放弃时结束 —— 与真机上挂住的 `--version` 同形:没有任何一方会替它收场。
          ctx.signal?.addEventListener('abort', () =>
            resolve(err({ type: 'capability-unsupported', providerId: 'claude', capability: 'acp' }))
          );
        })
    );
    const rt = new AcpRuntime(h.deps);

    const pending = rt.startSession(makeStartInput({ sessionId: 'conv-probe-hang' }));
    await probing;
    expect(buildAcpSpawn).toHaveBeenCalled();
    const starting = rt.sessionsListLiveModel().states.list.snapshot().data['conv-probe-hang'];
    expect(starting?.lifecycle).toBe('starting');
    expect(starting?.startProgress).toMatchObject({ stage: 'checking-executable' });

    expect(await rt.stopSession('conv-probe-hang')).toEqual({ success: true, data: undefined });
    const result = await pending;
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/^Start cancelled while checking the engine executable/);
    // 属主停下的启动与停掉一条已起来的会话同一个收场:回到没在跑,❌ 记成起不来(侧栏会亮红点)。
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-probe-hang']).toBeUndefined();
    expect(h.children, '探针阶段就被取消 ⇒ 适配器从未被起').toHaveLength(0);
  });

  // #6183 ③: 启动没有时钟 ⇒ 卡住的适配器由属主放弃;放弃要说出卡在哪一步、等了多久。
  it('stop abandons a start stuck in initialize and reports the step it was cancelled in', async () => {
    let snapshot: Array<{ text: string }> = [];
    const promptQueueStore = {
      load: vi.fn(() => snapshot),
      save: vi.fn((_sessionId: string, prompts: readonly { text: string }[]) => {
        snapshot = prompts.map(({ text }) => ({ text }));
      }),
      clear: vi.fn(() => { snapshot = []; }),
    };
    const h = makeAcpHarness({ promptQueueStore });
    h.agent.initialize = vi.fn(() => new Promise(() => {}));
    const rt = new AcpRuntime(h.deps);

    const pending = rt.startSession({
      ...makeStartInput({ sessionId: 'conv-init-stuck' }),
      initialQueue: [{ text: 'first words', origin: 'manual' }],
    });
    await h.agent.called('initialize');
    expect(snapshot.map((prompt) => prompt.text), '阳控:启动途中这句已经排进去、存下了').toEqual(['first words']);
    // 等待看得见:摘要说着正在等哪一步
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-init-stuck']?.startProgress)
      .toMatchObject({ stage: 'starting-engine' });
    h.lastChild.kill.mockImplementation(() => h.lastChild.emitExit(null, 'SIGTERM'));

    expect(await rt.stopSession('conv-init-stuck')).toEqual({ success: true, data: undefined });
    expect(await pending).toMatchObject({ success: false, error: { type: 'initialize_failed' } });
    expect(h.lastChild.kill).toHaveBeenCalledWith('SIGTERM');
    const result = await pending;
    if (!result.success) {
      expect(result.error.message)
        .toMatch(/^Start cancelled while waiting for the engine to initialize .*after [\d.]+s in this step/);
    }
    // 停下 = 与停掉一条已起来的会话同一个收场:排着的队清掉(下次起不会把停下的话再发一遍)、回到没在跑。
    expect(snapshot).toEqual([]);
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-init-stuck']).toBeUndefined();
    expect(rt.sessionLiveModels('conv-init-stuck')).toBeNull();
  });

  // codex 0.146.0 真机上报的三档(`permissionProfile/list` 原样)。二档 fixture 抓不到下面这条:
  // 「找第一个非破坏性档」在两档里恰好等于 agent(可写),在三档里却变成了 :read-only。
  function codexThreeModeConfigOptions(selected: string) {
    return [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: ':read-only', name: 'Read Only' },
          { value: ':workspace', name: 'Workspace' },
          { value: ':danger-full-access', name: 'Danger Full Access' },
        ],
      },
    ];
  }

  it('picks the edit rung, not the first non-destructive one, for permissionMode=edit', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-three-modes',
      configOptions: codexThreeModeConfigOptions(':danger-full-access'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: codexThreeModeConfigOptions(':workspace'),
    });

    const started = await rt.startSession(
      makeStartInput({
        sessionId: 'conv-three-modes',
        permissionMode: 'edit',
        initialQueue: [{ text: 'ask before edits', origin: 'manual' }],
      })
    );

    expect(isOk(started)).toBe(true);
    // ⚠️ 判据是 `:workspace`。选中 `:read-only` 同样满足「不是破坏性档」,所以这条一旦
    // 退回旧的 find(!isDestructive) 就会红 —— 那正是用户看到的
    // 「选了『改之前问我』,agent 却什么都改不了」。
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-three-modes',
      configId: 'mode',
      value: ':workspace',
    });
  });

  it('honours an explicit read-only permissionMode', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-read-only',
      configOptions: codexThreeModeConfigOptions(':danger-full-access'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: codexThreeModeConfigOptions(':read-only'),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-read-only',
        initialQueue: [{ text: 'read only please', origin: 'manual' }],
      }),
      permissionMode: 'read-only',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-read-only',
      configId: 'mode',
      value: ':read-only',
    });
  });

  // opencode 的形状：`session/new` 只报 build / plan 两档，没有任何完全访问档 ——
  // 它的完全访问不是一个 mode，是 permission 规则。
  function twoModeConfigOptions(selected: string) {
    return [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'build', name: 'Build' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ];
  }

  it('会话包自己兑现了完全访问的家，档位表里找不到 ⇒ 放行（不是失败）', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'native' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-bundle-full-access',
      configOptions: twoModeConfigOptions('build'),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-bundle-full-access',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    // 这一档在 spawn 时就由会话包写进进程配置了，❌ 不该再去 set 一个凑数的档 ——
    // 两档里选哪个都是错的（build 是可写档不是完全访问，plan 更是反方向）。
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('会话包没兑现这一维的家，找不到就降到最接近的更严档（❌ 不是让会话起不来）', async () => {
    // 与上一条唯一的差别仍是 bundleAutonomy —— 它依然是那条放行分支的**对照组**，
    // 只是对照的内容换了：会话包兑现了 ⇒ 一个档都不 set（上一条）；没兑现 ⇒ 必须
    // 落到 build 并真的 set 它。两条读数相反，去掉前提这里立刻变形。
    //
    // ⚠️ 这里**不再**响亮失败：owner 2026-09-05 定的原则——「用户既然选择了以 bypass
    // 运行，我们就不该说启动不起来」。降的方向仍然只许往严（build 是可写档，比完全访问严），
    // 界面上会话页的档位下拉显示的就是实际生效那一档。
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'none' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-no-full-access',
      configOptions: twoModeConfigOptions('plan'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: twoModeConfigOptions('build'),
    });

    const result = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-no-full-access',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-no-full-access',
      configId: 'mode',
      value: 'build',
    });
  });

  it('完全访问落在一个表达不了它的原生档上,request_permission 仍由会话当场作答(#4808)', async () => {
    // copilot 的产品读数就是这一格:选了完全访问,原生档位表里没有这一档 ⇒ 启动落到可写档,
    // 然后第一条工具调用弹批准、没人点就一直挂着。判据是请求**以作答返回**且不进待决,
    // ❌ 不看是哪一家 —— 对照组是同一套装置里 permissionMode=edit 的那一条(应进待决)。
    const answered = async (permissionMode: 'full-access' | 'edit') => {
      const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'none' });
      const rt = new AcpRuntime(h.deps);
      const sessionId = `conv-4808-${permissionMode}`;
      h.agent.newSession.mockResolvedValueOnce({
        sessionId: 'session-4808',
        configOptions: twoModeConfigOptions('plan'),
      });
      h.agent.setSessionConfigOption.mockResolvedValueOnce({
        configOptions: twoModeConfigOptions('build'),
      });
      const started = await rt.startSession({
        ...makeStartInput({ sessionId }),
        permissionMode,
      });
      expect(isOk(started)).toBe(true);
      const response = h.client().requestPermission({
        sessionId: 'session-4808',
        toolCall: { toolCallId: 'tool-pwd', title: 'Print working directory', kind: 'execute' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const pending = rt.sessionLiveModels(sessionId)?.states.state.snapshot().data
        .pendingPermissions ?? [];
      return { response, pending };
    };

    const full = await answered('full-access');
    await expect(full.response).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    expect(full.pending).toEqual([]);

    const edit = await answered('edit');
    expect(edit.pending).toHaveLength(1);
  });

  it('grok 形状:整张档位表缺席 + per-surface 自治(仅 acp native)+ 完全访问 ⇒ 会话照起', async () => {
    // 这是 grok 1.0.13 在产品上的**真实死法**:它的 ACP server 结构上恒为完全访问,
    // `session/new` 连 configOptions 都不报（`!options`）,而它的 units.autonomy 是
    // **per-surface**（只有 acp 那条 native）。旧代码在这里死两次:
    //  · `!options` 直接 throw「did not expose a permission mode for the session」;
    //  · 就算走到放行,旧的扁平读 `.kind === 'native'` 对 per-surface 恒假（`'per-surface'`）。
    // 修好后:`resolveUnitDelivery` 解出 acp 那条 native ⇒ 放行,会话起得来。
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'per-surface-acp' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-grok-no-options' });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-grok-no-options',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    // 一个档都没报,更不该去 set 一个凑数的档。
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('per-surface 自治的家在「档位表里找不到完全访问」时也放行(第二道闸同样按腿解析)', async () => {
    // 对照上面那条:这里 configOptions **有**（build/plan），但没有完全访问档 ——
    // opencode 那类家的形状,只是把自治维换成 per-surface。证明第二道 throw（no-match）
    // 用的也是 `resolveUnitDelivery` 而不是扁平读,两道闸判得一致。
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'per-surface-acp' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-per-surface-no-match',
      configOptions: twoModeConfigOptions('build'),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-per-surface-no-match',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('会话包只能精确表达「完全访问」这一档 ⇒ 其余三档不许借道，降到更严的那一档', async () => {
    // 会话包的自治维只有两档（full-access / approval-required），plan / read-only / edit
    // 三档之间它分不出来。拿 `approval-required` 冒充用户选的那一档就是骗人 ——
    // 所以即使这家 bundleAutonomy 是 native，这三档也**不许借道放行**（借道 = 什么都不 set
    // 就 return，会话实际跑在 build 上却当作已满足只读）。
    //
    // 借道被挡住之后走的是降档：只读缺席 ⇒ 落到 plan（更严），❌ 不是 build（更松），
    // 也❌ 不是让会话起不来。
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'native' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-read-only-missing',
      configOptions: twoModeConfigOptions('build'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: twoModeConfigOptions('plan'),
    });

    const result = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-read-only-missing',
        initialQueue: [{ text: 'read only please', origin: 'manual' }],
      }),
      permissionMode: 'read-only',
    });

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-read-only-missing',
      configId: 'mode',
      value: 'plan',
    });
  });

  // 判据的另一侧:只剩比用户所选**更松**的档时,仍然响亮失败 —— 往松的方向落不是降级是越权。
  // 这条与上面两条合起来钉住不变量:会话实际生效的档**不得比用户所选的更松**。
  it('只剩更松的档时仍然响亮失败（❌ 不许把用户放进更大的权限）', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'none' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-plan-missing',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode' as const,
          type: 'select' as const,
          currentValue: 'build',
          options: [{ value: 'build', name: 'Build' }],
        },
      ],
    });

    const result = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-plan-missing',
        initialQueue: [{ text: 'plan only please', origin: 'manual' }],
      }),
      permissionMode: 'plan',
    });

    expect(isOk(result)).toBe(false);
    expect(JSON.stringify(result)).toContain('or anything more restrictive');
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  // claude 的档位映射表(impl/claude 里的 CLAUDE_PERMISSION_MODES 原样)。
  const claudeModes = {
    plan: { id: 'plan' },
    'read-only': { id: 'default', aliases: ['dontAsk'] },
    edit: { id: 'acceptEdits' },
    'full-access': { id: 'bypassPermissions' },
  } as const;

  /** 以 root 跑时 claude 的 ACP 桥真实上报的五档 —— 少了 `bypassPermissions`。 */
  function claudeRootModeConfigOptions(selected: string) {
    return [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'auto', name: 'Auto' },
          { value: 'default', name: 'Default' },
          { value: 'acceptEdits', name: 'Accept Edits' },
          { value: 'plan', name: 'Plan Mode' },
          { value: 'dontAsk', name: "Don't Ask" },
        ],
      },
    ];
  }

  // 这是本条修复的产品面读数:以 root 跑咕咕时 claude 的 ACP 桥不报 bypassPermissions
  // (它自己那条 `ALLOW_BYPASS = !IS_ROOT || IS_SANDBOX`)。用户选了完全访问 ⇒ 会话必须
  // 跑起来并落在编辑档,❌ 不是起不来。
  it('claude 以 root 跑时缺完全访问档 ⇒ 降到编辑档并把会话开起来', async () => {
    const h = makeAcpHarness({
      autoApprove: 'supported',
      autoApproveModes: claudeModes,
      bundleAutonomy: 'none',
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-claude-root',
      configOptions: claudeRootModeConfigOptions('default'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: claudeRootModeConfigOptions('acceptEdits'),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-claude-root',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-claude-root',
      configId: 'mode',
      value: 'acceptEdits',
    });
  });

  // qwen 的档位映射表(impl/qwen 里的 QWEN_PERMISSION_MODES 原样)和它权限那一维的声明(#6953 实测:
  // set_config_option mode 有回读;一轮在跑时当场生效 ⇒ busy reject)。
  const qwenModes = {
    plan: { id: 'plan' },
    'read-only': { id: 'default' },
    'full-access': { id: 'yolo' },
  } as const;
  const qwenPermission = {
    channel: 'acp-config-option',
    ack: 'ack-read-back',
    busy: 'reject',
    reloadRequired: false,
    recovery: 'none',
    allowStartupDowngrade: true,
  } as const;

  /** qwen 0.24.4 `session/new` 报的那一组:无 flag 起在 `auto`(不在档位表里),五档。 */
  function qwenModeConfigOptions(selected: string) {
    return [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'plan', name: 'Plan' },
          { value: 'default', name: 'Default' },
          { value: 'auto-edit', name: 'Auto Edit' },
          { value: 'auto', name: 'Auto' },
          { value: 'yolo', name: 'YOLO' },
        ],
      },
    ];
  }

  // #6953 qwen 从前缺权限那一维:完全访问悄悄停在 auto,其余三档起不来。声明之后四档都起得来,
  // 落在档位表里的那一档(编辑没有对应档 ⇒ 落到 default),❌ 留在 auto。
  // qwen 的表是完整的(modesExhaustive):编辑 ❌ 选中 `auto-edit` —— 按名字它像编辑,可它对任意路径的写入都放行。
  it.each([
    ['full-access', 'yolo'],
    ['edit', 'default'],
    ['read-only', 'default'],
    ['plan', 'plan'],
  ] as const)('qwen 选 %s ⇒ 会话起来、落在 %s,❌ 停在 auto(#6953)', async (permissionMode, applied) => {
    const h = makeAcpHarness({
      autoApprove: 'supported',
      autoApproveModes: qwenModes,
      bundleAutonomy: 'none',
    });
    const provider = h.deps.agentHost.get('claude');
    if (!provider) throw new Error('test provider missing');
    const acp = provider.capabilities.acp as { liveSettings?: Record<string, unknown> };
    acp.liveSettings = { ...acp.liveSettings, permission: qwenPermission };
    (provider.capabilities.autoApprove as { modesExhaustive?: true }).modesExhaustive = true;
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: `session-qwen-${permissionMode}`,
      configOptions: qwenModeConfigOptions('auto'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: qwenModeConfigOptions(applied),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: `conv-qwen-${permissionMode}`,
        initialQueue: [{ text: 'hello', origin: 'manual' }],
      }),
      permissionMode,
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: `session-qwen-${permissionMode}`,
      configId: 'mode',
      value: applied,
    });
    expect(
      rt.sessionLiveModels(`conv-qwen-${permissionMode}`)?.states.config.snapshot().data.modeOptions?.selected
    ).toBe(applied);
  });

  // 上一条真正的判假点在这里:claude 把 `auto`(交给模型分类器判批准/拒绝)排在档位表
  // **第一个**,而它**故意不在**咕咕的四档映射表里。按名字猜会算成 `edit` ——
  // 不滤掉声明表外的 id,用户选「编辑」就会选中 auto,而 auto 在会话页下拉里根本不存在。
  it('声明表外的档(claude 的 auto)不许被选中', async () => {
    const h = makeAcpHarness({
      autoApprove: 'supported',
      autoApproveModes: claudeModes,
      bundleAutonomy: 'none',
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-claude-auto',
      configOptions: claudeRootModeConfigOptions('default'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({
      configOptions: claudeRootModeConfigOptions('acceptEdits'),
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-claude-auto',
        initialQueue: [{ text: 'edit please', origin: 'manual' }],
      }),
      permissionMode: 'edit',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-claude-auto',
      configId: 'mode',
      value: 'acceptEdits',
    });
  });

  // droid 的形状:**只**声明有据的一档(auto-high = 完全访问),其余四档故意留空由启发式填
  // (impl/droid/index.ts)。这是「声明表外的 id 不许代表这一档」那道闸的**反向对照** ——
  // 收得太死就会把 droid 的 `normal` 一起挡掉,用户选「编辑」时一档都挑不出来、会话起不来。
  it('只声明一档的家(droid):没声明的档仍可按启发式填', async () => {
    const h = makeAcpHarness({
      autoApprove: 'supported',
      autoApproveModes: { 'full-access': { id: 'auto-high' } },
      bundleAutonomy: 'none',
    });
    const rt = new AcpRuntime(h.deps);
    const droidModes = (selected: string) => [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'normal', name: 'Normal' },
          { value: 'spec', name: 'Spec' },
          { value: 'auto-low', name: 'Auto Low' },
          { value: 'auto-medium', name: 'Auto Medium' },
          { value: 'auto-high', name: 'Auto High' },
        ],
      },
    ];
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-droid',
      configOptions: droidModes('auto-high'),
    });
    h.agent.setSessionConfigOption.mockResolvedValueOnce({ configOptions: droidModes('normal') });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-droid',
        initialQueue: [{ text: 'edit please', origin: 'manual' }],
      }),
      permissionMode: 'edit',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-droid',
      configId: 'mode',
      value: 'normal',
    });
  });

  // 「一个档都不报」且会话包也没兑现 —— 旧代码在这里 throw。阶梯顶端下不再 throw:
  // 这家自己默认跑在哪一档都不可能比完全访问更松,起来就行。
  it('一个档都不报的家:选了完全访问照样把会话开起来', async () => {
    const h = makeAcpHarness({ autoApprove: 'supported', bundleAutonomy: 'none' });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-no-modes-at-all' });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-no-modes-at-all',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  // 报了档、但没有一个能代表阶梯上的任何一档(claude 的 `auto` 被排除之后就只剩它)⇒
  // 挑不出目标。同样不 throw:顶端下起来就行。
  it('报的档一个都代表不了任何一档:选了完全访问照样开', async () => {
    const h = makeAcpHarness({
      autoApprove: 'supported',
      autoApproveModes: claudeModes,
      bundleAutonomy: 'none',
    });
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-only-auto',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode' as const,
          type: 'select' as const,
          currentValue: 'auto',
          options: [{ value: 'auto', name: 'Auto' }],
        },
      ],
    });

    const started = await rt.startSession({
      ...makeStartInput({
        sessionId: 'conv-only-auto',
        initialQueue: [{ text: 'full access please', origin: 'manual' }],
      }),
      permissionMode: 'full-access',
    });

    expect(isOk(started)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  it('gates initial permission mode by the provider auto-approve capability', async () => {
    const unsupported = makeAcpHarness({ autoApprove: 'none' });
    const unsupportedRuntime = new AcpRuntime(unsupported.deps);
    unsupported.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-no-mode-contract' });

    const allowed = await unsupportedRuntime.startSession(
      makeStartInput({
        sessionId: 'conv-no-mode-contract',
        permissionMode: 'edit',
        initialQueue: [{ text: 'default prompt', origin: 'manual' }],
      })
    );

    expect(allowed).toEqual({ success: true, data: { providerSessionId: 'session-no-mode-contract' } });
    expect(unsupported.agent.setSessionConfigOption).not.toHaveBeenCalled();
    await unsupported.agent.called('prompt');
    expect(unsupported.agent.prompt).toHaveBeenCalledTimes(1);

    const supported = makeAcpHarness({ autoApprove: 'supported' });
    const supportedRuntime = new AcpRuntime(supported.deps);
    supported.agent.newSession.mockResolvedValueOnce({ sessionId: 'session-missing-required-mode' });

    const rejected = await supportedRuntime.startSession(
      makeStartInput({
        sessionId: 'conv-missing-required-mode',
        permissionMode: 'edit',
        initialQueue: [{ text: 'must not run', origin: 'manual' }],
      })
    );

    expect(rejected).toMatchObject({ success: false, error: { type: 'initialize_failed' } });
    expect(supported.agent.prompt).not.toHaveBeenCalled();
  });

  it('publishes terminal state and output through live primitives', async () => {
    const { h, rt, client, providerSessionId } = await startHarness('conv-terminal');
    const terminal = new FakeAcpTerminalProcess();
    h.fakeHost.nextTerminal = terminal;
    const created = await client.createTerminal!({
      sessionId: providerSessionId,
      command: 'echo',
      args: [],
      cwd: '/tmp',
    });

    expect(rt.sessionLiveModels('conv-terminal')?.states.terminals.snapshot().data).toMatchObject([
      { terminalId: created.terminalId, command: 'echo', exitStatus: null },
    ]);

    const log = rt.terminalOutputLog(created.terminalId);
    if (!log) throw new Error('expected terminal log');
    const updates: unknown[] = [];
    const unsub = log.subscribe((update) => updates.push(update));
    terminal.pushOutput('hello');

    terminal.pushOutput(' world');

    expect(log.snapshot().data.text).toBe('hello world');
    expect(updates).toHaveLength(2);
    expect(updates.at(-1)).toMatchObject({ delta: { chunk: ' world' } });

    terminal.triggerExit({ exitCode: 0, signal: null });
    expect(rt.sessionLiveModels('conv-terminal')?.states.terminals.snapshot().data).toMatchObject([
      { terminalId: created.terminalId, exitStatus: { exitCode: 0, signal: null } },
    ]);
    unsub();
  });

  it('keeps a session visible as lost when the adapter process closes', async () => {
    const { h, rt } = await startHarness('conv-close');

    h.lastChild.emitExit(42);

    await untilSessionSummary(rt, 'conv-close', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-close').lifecycle).toBe('lost');
    expect(rt.getSessionState('conv-close').failure).toMatchObject({ kind: 'adapter-exit', exitCode: 42 });
    expect(rt.sessionLiveModels('conv-close')).not.toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-close']).toMatchObject({
      lifecycle: 'lost',
      failure: { kind: 'adapter-exit', exitCode: 42 },
    });
  });

  it('keeps normal stop/delete on the non-error cleanup path', async () => {
    const { rt } = await startHarness('conv-normal-stop');

    await expect(rt.stopSession('conv-normal-stop')).resolves.toMatchObject({ success: true });

    expect(rt.getSessionState('conv-normal-stop').lastTurnOutcome).toBe('none');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data).toEqual({});
  });

  it('tells an attached subscriber the session is closed before its live models go away (#6497)', async () => {
    // 宿主故意停掉会话(归档 / 切到编程模式 / 父会话 session_stop / 远程停止)时,live 实例被 dispose ——
    // session-wire 不通知订阅方,渲染侧那份 replica 从此沉默,聊天面攥着死句柄发不出消息。
    // 判据:停之前就挂上的订阅方,必须收到最后一次 state,且 lifecycle 是 closed。
    const { rt } = await startHarness('conv-stop-notifies');
    const live = rt.sessionLiveModels('conv-stop-notifies');
    if (!live) throw new Error('expected live models');
    expect(live.states.state.snapshot().data.lifecycle).toBe('ready');
    const updates: unknown[] = [];
    const unsubscribe = live.states.state.subscribe((update) => updates.push(update));

    await expect(rt.stopSession('conv-stop-notifies')).resolves.toMatchObject({ success: true });

    expect(updates.length).toBeGreaterThan(0);
    expect(live.states.state.snapshot().data).toMatchObject({
      lifecycle: 'closed',
      activeTurnId: null,
      canSubmit: false,
      isGenerating: false,
    });
    // 停之后这条会话在运行时里就不存在了:读法与推送给的是同一个答案。
    expect(rt.sessionLiveModels('conv-stop-notifies')).toBeNull();
    expect(rt.getSessionState('conv-stop-notifies').lifecycle).toBe('closed');
    unsubscribe();
  });

  it('publishes an errored summary and carries queued prompts across an abnormal process close', async () => {
    const { h, rt } = await startHarness('conv-abnormal-close');
    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
    );

    const inFlight = rt.sendPrompt('conv-abnormal-close', { text: 'first' });
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    await expect(rt.queuePrompt('conv-abnormal-close', { text: 'during', origin: 'typed' })).resolves.toMatchObject({
      success: true,
    });

    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-abnormal-close', 'the interrupted turn settles',
      (summary) => summary?.lastTurnOutcome === 'errored');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-abnormal-close']?.lastTurnOutcome)
      .toBe('errored');
    const summary = rt.sessionsListLiveModel().states.list.snapshot().data['conv-abnormal-close'];
    expect(summary).toMatchObject({ lifecycle: 'lost', queuedPromptCount: 1, failure: { kind: 'adapter-exit' } });
    expect(rt.sessionLiveModels('conv-abnormal-close')).not.toBeNull();

    resolvePrompt({ stopReason: 'end_turn' });
    await inFlight;

    h.agent.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    await expect(rt.startSession(makeStartInput({ sessionId: 'conv-abnormal-close', providerSessionId: 'session-1' })))
      .resolves.toMatchObject({ success: true });
    await expect(rt.sendPrompt('conv-abnormal-close', { text: 'recover' })).resolves.toMatchObject({
      success: true,
      data: { queued: false },
    });
    await untilSessionSummary(rt, 'conv-abnormal-close', 'the queue drains',
      (summary) => summary?.queuedPromptCount === 0);
    expect(rt.getSessionState('conv-abnormal-close').queuedPrompts).toEqual([]);
    expect(h.agent.prompt).toHaveBeenCalledTimes(3);
  });

  /**
   * ⭐ **防回归的那一条(#5858 的要害)。**
   *
   * 上游网关回错时,`detail` 里带着那句唯一能归因的话(真机实测:
   * 「No available channel for model … under group auto」+ request id)。而「失败一轮 →
   * 用户随手关掉会话 → 引擎退出」是最常见的收尾路径之一 —— 如果改口只看时序,
   * 那句话就会被**自己的修复**改写成「进程没了」,连 #4875 ② 一起退回去。
   * ⇒ provider 说过话的那一条是 final:退出之后文案**逐字不变**。
   * 反向那一条(传输层塌了 ⇒ 必须被改写)就在下面一条,两条成对看。
   */
  it('上游说过话的那一轮:进程随后退出也不许改写它的文案', async () => {
    const { h, rt } = await startHarness('conv-upstream-final');
    h.agent.prompt.mockRejectedValueOnce(
      Object.assign(new Error('Internal error'), {
        data: { details: 'No available channel for model glm-5.3 under group auto (distributor)' },
      })
    );

    await expect(rt.sendPrompt('conv-upstream-final', { text: 'first' })).resolves.toMatchObject({
      success: false,
    });
    const before = rt.getHistory('conv-upstream-final');
    expect(before.success).toBe(true);
    if (!before.success) return;
    const settled = before.data.turns.at(-1)?.outcome;
    expect(settled).toMatchObject({
      kind: 'error',
      reason: 'prompt_failed',
      detail: 'No available channel for model glm-5.3 under group auto (distributor)',
    });

    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-upstream-final', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-upstream-final').lifecycle).toBe('lost');

    const after = rt.getHistory('conv-upstream-final');
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(
      after.data.turns.at(-1)?.outcome,
      '上游那句话被「进程没了」抹掉了 —— 这正是 #5858 要救的东西'
    ).toEqual(settled);
  });

  it('preserves an errored summary when prompt failure settles before process close', async () => {
    const revisions: Array<{ source: string; reason?: string }> = [];
    const { h, rt } = await startHarness('conv-settled-before-close', {
      onTurnCommitted: ({ source, turn }) => revisions.push({
        source,
        reason: turn.outcome?.kind === 'error' ? turn.outcome.reason : undefined,
      }),
    });
    h.agent.prompt.mockRejectedValueOnce(new Error('connection closed'));

    await expect(rt.sendPrompt('conv-settled-before-close', { text: 'first' })).resolves.toMatchObject({
      success: false,
      error: { type: 'prompt_failed' },
    });
    expect(rt.getSessionState('conv-settled-before-close').lastTurnOutcome).toBe('errored');

    h.lastChild.emitExit(137);

    await untilSessionSummary(rt, 'conv-settled-before-close', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-settled-before-close').lifecycle).toBe('lost');
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-settled-before-close']).toMatchObject({
      lifecycle: 'lost',
      lastTurnOutcome: 'errored',
      failure: { kind: 'adapter-exit', exitCode: 137 },
    });
    const history = rt.getHistory('conv-settled-before-close');
    expect(history.success).toBe(true);
    if (!history.success) return;
    const outcome = history.data.turns.at(-1)?.outcome;
    // #5858:这一格的时序**就是真机上的常态** —— 连接塌掉先把在飞的 prompt 拒掉,进程的 exit
    // 毫秒之后才到。改口之后这一轮说的是「引擎退了(码 137)」。
    expect(outcome).toMatchObject({ kind: 'error', reason: 'process_closed' });

    /**
     * ⭐ **改口的不变量:先落定的那句话必须逐字还在。**
     *
     * 新规则下有一个分不开的形状:一个既没 `code`、也没 `data`、类名也不是 `RequestError`
     * 的 provider 错误(只有一句 message 的裸 `Error`),与「传输层塌了」**长得一模一样** ⇒
     * 真撞上「这种错误 + 随后异常退出 + 期间没有新轮」,它的 reason 就会被改成 `process_closed`。
     *
     * 这条判据就是那个形状的**解药**:改口只让 reason 更具体,**原话一个字都不许丢**。
     * ⇒ 有它,上面那个分不开的形状只是精度问题;没有它,它就是下一个 #5858。
     * ❌ 因此不许把这条简化成「只断言 reason 变了」。
     */
    expect(
      (outcome as { detail?: string }).detail,
      '改口把 provider 原来那句话弄丢了 —— 那正是本票要救的东西'
    ).toContain('connection closed');
    expect((outcome as { detail?: string }).detail).toContain('exit code=137');
    expect(revisions).toEqual([
      { source: 'live', reason: 'prompt_failed' },
      { source: 'revision', reason: 'process_closed' },
    ]);
  });

  /**
   * 改口的第三道闸:**只认同一个进程实例**。
   *
   * 另一条连接的退出事件不许去改写这条会话里的轮 —— 否则两条并存的会话会串台,
   * 而串台后的读数看起来完全正常(它就是一条合法的 `process_closed`),没有任何东西会报错。
   */
  it('另一条连接的退出不许改写这条会话里那一轮', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' });

    await rt.startSession(makeStartInput({ sessionId: 'conv-x', workspaceId: 'ws-1' }));
    await rt.startSession(makeStartInput({ sessionId: 'conv-y', workspaceId: 'ws-1' }));
    expect(h.children).toHaveLength(2);

    // conv-x 上落一条**暂定**的失败(传输层塌了那一类)。
    h.agent.prompt.mockRejectedValueOnce(new Error('ACP connection closed'));
    await expect(rt.sendPrompt('conv-x', { text: 'first' })).resolves.toMatchObject({ success: false });
    const before = rt.getHistory('conv-x');
    expect(before.success).toBe(true);
    if (!before.success) return;
    const settled = before.data.turns.at(-1)?.outcome;
    expect(settled).toMatchObject({ kind: 'error', reason: 'prompt_failed' });

    // 退出的是**另一条**连接。
    h.children[1]?.emitExit(42);
    await untilSessionSummary(rt, 'conv-y', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-y').lifecycle).toBe('lost');

    expect(rt.getSessionState('conv-x').lifecycle).toBe('ready');
    const after = rt.getHistory('conv-x');
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(after.data.turns.at(-1)?.outcome, '别家连接的退出串到这条会话里来了').toEqual(settled);
  });

  it('closes only the conversation owned by an exited adapter process', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession
      .mockResolvedValueOnce({ sessionId: 'session-a' })
      .mockResolvedValueOnce({ sessionId: 'session-b' });

    await rt.startSession(makeStartInput({ sessionId: 'conv-a', workspaceId: 'ws-1' }));
    await rt.startSession(makeStartInput({ sessionId: 'conv-b', workspaceId: 'ws-1' }));
    expect(h.children).toHaveLength(2);

    h.children[0]?.emitExit(42);

    await untilSessionSummary(rt, 'conv-a', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-a').lifecycle).toBe('lost');
    expect(rt.getSessionState('conv-b').lifecycle).toBe('ready');
    expect(rt.sessionLiveModels('conv-a')).not.toBeNull();
    expect(rt.sessionLiveModels('conv-b')).not.toBeNull();

    h.children[1]?.emitExit(42);

    await untilSessionSummary(rt, 'conv-b', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-b').lifecycle).toBe('lost');
    expect(rt.sessionLiveModels('conv-b')).not.toBeNull();
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-a']).toMatchObject({ lifecycle: 'lost' });
    expect(rt.sessionsListLiveModel().states.list.snapshot().data['conv-b']).toMatchObject({ lifecycle: 'lost' });
  });

  it('records an adapter loss and requires explicit reconnect before accepting a prompt', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ sessionId: 'conv-lost' }));

    h.lastChild.emitExit(137);

    await untilSessionSummary(rt, 'conv-lost', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-lost').lifecycle).toBe('lost');
    expect(rt.getSessionState('conv-lost').failure).toMatchObject({
      kind: 'adapter-exit',
      exitCode: 137,
    });
    await expect(rt.sendPrompt('conv-lost', { text: 'must not be accepted' })).resolves.toMatchObject({
      success: false,
      error: { type: 'invalid_state' },
    });
    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
  });

  it('reconnects a lost session through its original provider session', async () => {
    const onPlatformSessionClosed = vi.fn();
    const h = makeAcpHarness({ onPlatformSessionClosed });
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'conv-reconnect',
      platformAccessSessionId: 'access-old',
      sessionMeta: { claudeCode: { options: { settings: '/tmp/settings-old.json' } } },
      initialQueue: [{ text: 'first turn', origin: 'manual' }],
    }));
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);

    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-reconnect', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-reconnect').lifecycle).toBe('lost');
    expect(onPlatformSessionClosed).toHaveBeenCalledWith('conv-reconnect', 'access-old');

    h.agent.loadSession = vi.fn().mockResolvedValue({});
    h.agent.prompt.mockResolvedValue({ stopReason: 'end_turn' });
    await expect(rt.startSession(makeStartInput({
      sessionId: 'conv-reconnect',
      platformAccessSessionId: 'access-new',
      sessionMeta: { claudeCode: { options: { settings: '/tmp/settings-new.json' } } },
    })))
      .resolves.toEqual({ success: true, data: { providerSessionId: 'session-1' } });

    expect(h.agent.newSession).toHaveBeenCalledTimes(1);
    expect(h.agent.loadSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      _meta: { claudeCode: { options: { settings: '/tmp/settings-new.json' } } },
    }));
    // The startup prompt was already consumed by the interrupted adapter; transcript replay owns
    // that history, so reconnect must not submit the original startup queue a second time.
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    expect(rt.getSessionState('conv-reconnect').lifecycle).toBe('ready');
    await expect(rt.sendPrompt('conv-reconnect', { text: 'after reconnect' }))
      .resolves.toMatchObject({ success: true, data: { queued: false } });
  });

  it('waits for dead adapter eviction before explicitly reconnecting', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-eviction' }));

    let releaseEviction!: () => void;
    const eviction = new Promise<void>((resolve) => { releaseEviction = resolve; });
    const realInvalidate = rt.connections.invalidate.bind(rt.connections);
    const invalidate = vi.spyOn(rt.connections, 'invalidate').mockImplementation(async (key) => {
      await eviction;
      await realInvalidate(key);
    });

    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-reconnect-eviction', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-reconnect-eviction').lifecycle).toBe('lost');

    const reconnect = rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-eviction' }));
    await Promise.resolve();
    expect(h.children).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledTimes(1);

    releaseEviction();
    await expect(reconnect).resolves.toMatchObject({ success: true });
    expect(h.children).toHaveLength(2);
  });

  it('marks an interrupted replay turn errored before reconnect becomes ready', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-interrupted' }));

    let resolvePrompt!: (value: { stopReason: 'end_turn' }) => void;
    h.agent.prompt = vi.fn(
      () => new Promise<{ stopReason: 'end_turn' }>((resolve) => { resolvePrompt = resolve; })
    );
    const inFlight = rt.sendPrompt('conv-reconnect-interrupted', { text: 'interrupted' });
    await h.agent.called('prompt');
    expect(h.agent.prompt).toHaveBeenCalledTimes(1);
    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-reconnect-interrupted', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-reconnect-interrupted').lifecycle).toBe('lost');
    resolvePrompt({ stopReason: 'end_turn' });
    await inFlight;

    h.agent.loadSession = vi.fn(async () => {
      await h.client().sessionUpdate({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          sessionId: 'session-1',
          messageId: 'replayed-active-turn',
          content: { type: 'text', text: 'partial before adapter exit' },
        } as SessionUpdate,
      });
      return {};
    });
    await expect(rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-interrupted' })))
      .resolves.toMatchObject({ success: true });

    const state = rt.getSessionState('conv-reconnect-interrupted');
    expect(state.lifecycle).toBe('ready');
    expect(state.lastTurnOutcome).toBe('errored');
    expect(state.activeTurnId).toBeNull();
    const history = rt.getHistory('conv-reconnect-interrupted');
    expect(history.success).toBe(true);
    if (!history.success) return;
    // #5858:重连收口那一轮不再冒充「这条指令没能送达」—— 它丢的是引擎,不是指令。
    expect(history.data.turns.at(-1)?.outcome).toMatchObject({
      kind: 'error',
      reason: 'process_closed',
      detail: 'ACP adapter exited unexpectedly (code 137)',
    });
    expect(rt.sessionLiveModels('conv-reconnect-interrupted')?.states.activeTurn.snapshot().data).toBeNull();
  });

  it('keeps the lost state when explicit reconnect cannot load the provider session', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-failed' }));

    h.lastChild.emitExit(137);
    await untilSessionSummary(rt, 'conv-reconnect-failed', 'adapter exit marks the session lost', (summary) => summary?.lifecycle === 'lost');
    expect(rt.getSessionState('conv-reconnect-failed').lifecycle).toBe('lost');
    h.agent.loadSession = vi.fn().mockRejectedValue(new Error('transcript is unavailable'));

    await expect(rt.startSession(makeStartInput({ sessionId: 'conv-reconnect-failed' })))
      .resolves.toMatchObject({ success: false });
    expect(rt.getSessionState('conv-reconnect-failed').lifecycle).toBe('lost');
    expect(rt.getSessionState('conv-reconnect-failed').failure).toMatchObject({
      kind: 'adapter-exit',
      exitCode: 137,
    });
  });

  it('keeps system bootstrap queue work in ACP provider history', async () => {
    // initialQueue is a compatibility system-bootstrap transport, never a user-text create API.
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    await rt.startSession(makeStartInput({
      sessionId: 'conv-system-bootstrap',
      sessionPrompt: '<gugu_platform>Resident context</gugu_platform>',
      initialQueue: [{ text: 'Run the scheduled maintenance task', origin: 'manual' }],
    }));

    // 先证明这条 prompt 确实发出去了 —— 否则下面的空 history 只是「还没跑到」而不是「丢了」
    await h.agent.called('prompt');
    expect(h.agent.prompt, '[阳控] 初始队列那条 prompt 必须真的发给了 provider').toHaveBeenCalled();

    const history = rt.getHistory('conv-system-bootstrap');
    expect(JSON.stringify(history)).toContain('Run the scheduled maintenance task');
    // 且它是一条【干净的】用户消息 —— 没有被系统块污染
    expect(JSON.stringify(history)).not.toContain('gugu_platform');
    // 发往 provider 的那一条也必须是干净的
    expect(h.agent.prompt).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'Run the scheduled maintenance task' }],
    });
  });
});

/**
 * #6196 —— 续接已有 provider 会话时,会话记录里的**平台模型**也要断言一次。
 *
 * pi / copilot 恢复会话时回到会话记忆里的模型,spawn 按新模型物化的注入不算数(macOS 裸 ACP 实测,
 * 2026-09-22)。这组用例钉的是**规则**,不是哪一家:
 * 下发值取活会话自报的寻址形式;自报当前值已是它就不发;新会话与声明 `reload-session` 的维度交给 spawn。
 */
describe('recorded platform model on a resumed provider session (#6196)', () => {
  function platformModelOptions(selected: string) {
    return [
      {
        id: 'model',
        name: 'Model',
        category: 'model' as const,
        type: 'select' as const,
        currentValue: selected,
        options: [
          { value: 'gugu-platform/glm-5.3', name: 'GLM 5.3' },
          { value: 'gugu-platform/glm-5.3-flash', name: 'GLM 5.3 Flash' },
        ],
      },
    ];
  }

  function declareModelSetting(
    h: ReturnType<typeof makeAcpHarness>,
    model: Record<string, unknown>,
  ) {
    const provider = h.deps.agentHost.get('claude');
    if (!provider) throw new Error('test provider missing');
    const acp = provider.capabilities.acp as { liveSettings?: Record<string, unknown> };
    acp.liveSettings = { ...acp.liveSettings, model };
  }

  const liveModel = {
    channel: 'acp-config-option',
    ack: 'ack',
    busy: 'reject',
    reloadRequired: false,
    recovery: 'none',
  };

  function resumeInput(sessionId: string, extra: Partial<AcpStartInput>) {
    return { ...makeStartInput({ sessionId, ...extra }), providerSessionId: 'session-existing' };
  }

  it('asserts the platform model in the address the live session advertises', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });

    const result = await rt.resumeSession(resumeInput('conv-pi-shape', { platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-existing',
      configId: 'model',
      value: 'gugu-platform/glm-5.3-flash',
    });
  });

  // 阴控:自报当前值已是它 ⇒ 断言已成立,不再发(同一判据,只差 currentValue)。
  it('does not re-send when the resumed session already reports the recorded model', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3-flash') });

    const result = await rt.resumeSession(resumeInput('conv-already', { platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  // copilot 的形状:`configOptions` 一条 model 都不报,但声明了 `configId` —— 平台与自己的模型都要能断言。
  it.each([
    ['platform', { platformModel: 'glm-5.3-flash' }, 'glm-5.3-flash'],
    ['own', { model: 'own-model' }, 'own-model'],
  ] as const)('asserts the %s model through a declared config id the provider never advertises', async (_label, extra, value) => {
    const h = makeAcpHarness();
    declareModelSetting(h, { ...liveModel, configId: 'model' });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: modeConfigOptions('agent') });

    const result = await rt.resumeSession(resumeInput(`conv-copilot-${_label}`, extra));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-existing',
      configId: 'model',
      value,
    });
  });

  it('leaves a brand-new provider session to the spawn that pinned it', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.newSession.mockResolvedValueOnce({
      sessionId: 'session-new',
      configOptions: platformModelOptions('gugu-platform/glm-5.3'),
    });

    const result = await rt.startSession(makeStartInput({ sessionId: 'conv-new', platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });

  // 没有活通道 = 断言不了:❌ 不发一条注定被拒的设置,也 ❌ 不把会话判死;只响亮记一行。
  it('does not send anything, and says so, when the provider declares no live model setting', async () => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.get('claude');
    if (!provider) throw new Error('test provider missing');
    const acp = provider.capabilities.acp as { liveSettings?: Record<string, unknown> };
    acp.liveSettings = { permission: acp.liveSettings?.permission, effort: acp.liveSettings?.effort };
    const warn = vi.fn();
    h.deps.logger = { ...h.deps.logger, warn };
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });

    const result = await rt.resumeSession(resumeInput('conv-undeclared', { platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('declares no live model setting'),
      expect.objectContaining({ sessionId: 'conv-undeclared', model: 'glm-5.3-flash' }),
    );
  });

  // provider 拒了平台模型:会话照常开、跑它恢复出来的那个,转录里一行说实话(与自己的模型被拒同一条路)。
  it('opens on the model the provider restored, with a notice, when it refuses the recorded platform model', async () => {
    const h = makeAcpHarness();
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });
    h.agent.setSessionConfigOption
      .mockRejectedValueOnce(new Error('unknown model: gugu-platform/glm-5.3-flash'))
      .mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });

    const result = await rt.resumeSession(resumeInput('conv-refused', { platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-existing',
      configId: 'model',
      value: 'gugu-platform/glm-5.3',
    });
    const history = JSON.stringify(rt.getChatHistory('conv-refused'));
    expect(history).toContain('model-unavailable');
    expect(history).toContain('unknown model: gugu-platform/glm-5.3-flash');
  });

  // 两半同时在场 = 记录自相矛盾;spawn 按平台那一半起的 ⇒ 断言平台那一半,并响亮记下。
  it('asserts the platform half and reports the contradiction when both halves arrive', async () => {
    const h = makeAcpHarness();
    const error = vi.fn();
    h.deps.logger = { ...h.deps.logger, error };
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });

    const result = await rt.resumeSession(resumeInput('conv-both', { platformModel: 'glm-5.3-flash', model: 'own-model' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledTimes(1);
    expect(h.agent.setSessionConfigOption).toHaveBeenCalledWith({
      sessionId: 'session-existing',
      configId: 'model',
      value: 'gugu-platform/glm-5.3-flash',
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('both a platform model and an own model'),
      expect.objectContaining({ sessionId: 'conv-both' }),
    );
  });

  it('leaves a model dimension declared reload-session to the spawn on resume', async () => {
    const h = makeAcpHarness();
    declareModelSetting(h, { ...liveModel, channel: 'reload-session', ack: 'none', reloadRequired: true, recovery: 'runtime-restart' });
    const rt = new AcpRuntime(h.deps);
    h.agent.loadSession.mockResolvedValueOnce({ configOptions: platformModelOptions('gugu-platform/glm-5.3') });

    const result = await rt.resumeSession(resumeInput('conv-qwen-shape', { platformModel: 'glm-5.3-flash' }));

    expect(isOk(result)).toBe(true);
    expect(h.agent.setSessionConfigOption).not.toHaveBeenCalled();
  });
});
