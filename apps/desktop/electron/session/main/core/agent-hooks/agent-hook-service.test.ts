import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentHookService,
  providerSupportsNativeStartHook,
  sessionTuiTurnStartPublishedByHostAdapter,
} from './agent-hook-service';
import { sessionEvents } from '@main/core/sessions/session-events';

type HookRequest = { ptyId: string; type: string; body: string };
const hookServerState = vi.hoisted(() => ({
  handler: undefined as ((raw: HookRequest) => Promise<void>) | undefined,
}));
const parseHookEventMock = vi.hoisted(() => vi.fn());
const setProviderSessionIdMock = vi.hoisted(() => vi.fn());

vi.mock('./hook-server', () => ({
  HookServer: class {
    async start(handler: (raw: HookRequest) => Promise<void>) {
      hookServerState.handler = handler;
    }
    stop() {}
    getPort() {
      return 0;
    }
    createSource(ptyId: string) {
      return { id: `source-${ptyId}`, token: 'token', dispose() {} };
    }
  },
}));

vi.mock('./event-enricher', () => ({ parseHookEvent: parseHookEventMock }));

vi.mock('@main/core/sessions/set-session-id', () => ({
  setProviderSessionId: setProviderSessionIdMock,
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));

vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn((id: string) => ({
    capabilities: {
      hooks:
        id === 'amp'
          ? { kind: 'plugin', scope: 'workspace', supportedEvents: ['start', 'stop', 'session'] }
          : {
              kind: 'config',
              scope: 'agent-home',
              supportedEvents: ['notification', 'stop', 'session'],
            },
      sessionBundle: {
        sessionpage: {
          'tui':
            id === 'opencode' || id === 'mimocode'
              ? { identity: 'addressable', messageTransport: 'router', hostAdapter: 'opencode-serve-attach-v1' }
              : { identity: 'addressable', messageTransport: 'router' },
        },
      },
    },
    behavior: {
      sessionBundle: id === 'codex' ? { sessionTuiHostAdapter: 'codex-app-server-v1' } : undefined,
      sessions: {
        validateProviderSessionId:
          id === 'droid'
            ? (value: string) =>
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                  value
                )
            : id === 'opencode'
              ? (value: string) => value.startsWith('ses')
            : undefined,
      },
    },
  })),
  isValidProviderId: vi.fn((value: unknown) => typeof value === 'string'),
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

describe('providerSupportsNativeStartHook', () => {
  it('detects providers that emit native start hooks', () => {
    expect(providerSupportsNativeStartHook('amp')).toBe(true);
  });

  it('does not treat other hook support as native start support', () => {
    expect(providerSupportsNativeStartHook('codex')).toBe(false);
  });
});

// #6391 serve/attach 腿的回合起点由 serve SSE 发布;回车合成的 start 在那里没有终点。
describe('sessionTuiTurnStartPublishedByHostAdapter', () => {
  it.each(['opencode', 'mimocode'])('%s tui owns its turn start through the serve relay', (id) => {
    expect(sessionTuiTurnStartPublishedByHostAdapter(id)).toBe(true);
  });
  // #6410 codex 的适配器不在描述符上,在 behavior 里选(与 resolveSessionTuiHostAdapter 同序)。
  it('codex tui owns its turn start through the app-server relay', () => {
    expect(sessionTuiTurnStartPublishedByHostAdapter('codex')).toBe(true);
  });
  it('a plain pty leg keeps the keystroke-synthesized start', () => {
    expect(sessionTuiTurnStartPublishedByHostAdapter('qwen')).toBe(false);
  });
});

describe('Enter in an agent terminal (#6391)', () => {
  beforeAll(async () => {
    await agentHookService.initialize();
  });
  afterAll(() => {
    agentHookService.dispose();
  });

  const submit = (providerId: string) =>
    sessionEvents._emit('session:input-submitted', {
      projectId: 'project-1',
      sessionId: `conversation-${providerId}`,
      providerId,
    });

  // `_emit` 是 callHookBackground(异步、按序)⇒ 立刻断言「没调用」恒真。qwen 那条合成 start 是屏障:
  // 它到了,排在它前面的两条也一定处理完了;于是「只有它一条」同时是阳控(合成仍在)与阴控(serve 腿没有)。
  it('synthesizes start for a plain pty leg but not for a serve/attach leg, whose only terminal edge follows a real serve busy', async () => {
    const firstEmit = Promise.withResolvers<void>();
    const emit = vi.spyOn(agentHookService, 'emitAgentEvent').mockImplementation(() => firstEmit.resolve());
    submit('opencode');
    submit('mimocode');
    submit('codex');
    submit('qwen');
    await firstEmit.promise;
    expect(emit.mock.calls.map(([event]) => `${event.providerId}:${event.type}`)).toEqual(['qwen:start']);
    emit.mockRestore();
  });
});


describe('provider session handoff', () => {
  beforeAll(async () => {
    await agentHookService.initialize();
  });

  beforeEach(() => {
    parseHookEventMock.mockReset();
    setProviderSessionIdMock.mockReset();
  });

  afterAll(() => {
    agentHookService.dispose();
  });

  it('publishes a provider session id only after persistence succeeds', async () => {
    const persistence = Promise.withResolvers<{ success: true; data: undefined }>();
    const persisting = Promise.withResolvers<void>();
    setProviderSessionIdMock.mockImplementationOnce(() => {
      persisting.resolve();
      return persistence.promise;
    });
    parseHookEventMock.mockResolvedValueOnce({
      kind: 'session',
      ctx: {
        sessionId: 'conversation-1',
        projectId: 'project-1',
        providerId: 'opencode',
        ptyId: 'opencode:conversation-1',
        sourceId: 'source-opencode:conversation-1',
      },
      providerSessionId: 'ses_child',
    });
    const listener = vi.fn();
    const stopListening = agentHookService.on('agent:session', listener);

    const handling = hookServerState.handler!({
      ptyId: 'opencode:conversation-1',
      type: 'session',
      body: '{}',
    });
    await persisting.promise;
    expect(setProviderSessionIdMock).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();

    persistence.resolve({ success: true, data: undefined });
    await handling;

    expect(listener).toHaveBeenCalledWith({
      sessionId: 'conversation-1',
      projectId: 'project-1',
      providerId: 'opencode',
      ptyId: 'opencode:conversation-1',
      sourceId: 'source-opencode:conversation-1',
      providerSessionId: 'ses_child',
    });
    stopListening();
  });

  it('does not publish an invalid provider session id', async () => {
    parseHookEventMock.mockResolvedValueOnce({
      kind: 'session',
      ctx: {
        sessionId: 'conversation-1',
        projectId: 'project-1',
        providerId: 'droid',
        ptyId: 'droid:conversation-1',
      },
      providerSessionId: 'not-a-droid-uuid',
    });
    const listener = vi.fn();
    const stopListening = agentHookService.on('agent:session', listener);

    await hookServerState.handler!({
      ptyId: 'droid:conversation-1',
      type: 'session',
      body: '{}',
    });

    expect(setProviderSessionIdMock).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    stopListening();
  });

  it('does not publish a provider session id when persistence fails', async () => {
    setProviderSessionIdMock.mockResolvedValueOnce({
      success: false,
      error: { type: 'session-not-found' },
    });
    parseHookEventMock.mockResolvedValueOnce({
      kind: 'session',
      ctx: {
        sessionId: 'missing-conversation',
        projectId: 'project-1',
        providerId: 'droid',
        ptyId: 'droid:missing-conversation',
      },
      providerSessionId: '123e4567-e89b-12d3-a456-426614174000',
    });
    const listener = vi.fn();
    const stopListening = agentHookService.on('agent:session', listener);

    await hookServerState.handler!({
      ptyId: 'droid:missing-conversation',
      type: 'session',
      body: '{}',
    });

    expect(listener).not.toHaveBeenCalled();
    stopListening();
  });
});
