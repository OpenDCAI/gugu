import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent, NotificationType } from '@shared/core/agents/agentEvents';

/**
 * 桌面的 agent 系统横幅跟着状态写入者的那一份读数走(owner 10-30):停下来等你批准 / 回答才弹,做完、出错不弹。
 * 读数从哪条路来都一样 —— 终端 hook 带 sourceId,ACP 会话的边(acp/agent-status-bridge)没有;从前横幅只认带
 * sourceId 的那条,ACP 任务等批准时手机响了、桌面一声不响。判据打在真 SQLite 和真的 maybeShowNotification 上,只把系统横幅换成计数。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, settings: { enabled: true, sound: true }, banners: [] as Array<{ title: string; body: string; silent: boolean }> }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  BrowserWindow: class {},
  Notification: class {
    static isSupported() {
      return true;
    }
    constructor(options: { title: string; body: string; silent: boolean }) {
      mocks.banners.push(options);
    }
    on() {}
    show() {}
  },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: async () => mocks.settings },
}));
vi.mock('../agent-hooks/hook-server', () => ({
  HookServer: class {
    async start() {}
    stop() {}
    getPort() {
      return 0;
    }
    createSource(ptyId: string) {
      return { id: `source-${ptyId}`, token: 'token', dispose() {} };
    }
  },
}));
vi.mock('../agent-hooks/event-enricher', () => ({ parseHookEvent: vi.fn() }));
vi.mock('../agent-hooks/app-focus', () => ({ isAppFocused: () => false }));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error', 'wait'] } }, behavior: {} })),
  getPluginMetadata: vi.fn(() => ({ name: 'Codex' })),
  isValidProviderId: vi.fn(() => true),
}));
vi.mock('@main/core/pty/controller', () => ({ ptyController: { interrupt: vi.fn() } }));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');
const { setSessionAgentNotificationCopy } = await import('../agent-hooks/notification-copy');

let clock = 1_000;
let cid = 'c0';
function event(type: AgentEvent['type'], payload: AgentEvent['payload'] = {}, sourceId?: string): AgentEvent {
  clock += 1;
  return { type, providerId: 'codex', projectId: 'p1', sessionId: cid, timestamp: clock, payload, ...(sourceId ? { sourceId } : {}) };
}

describe('desktop agent banners follow the status reading, whatever path it came by', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const deliver = async (e: AgentEvent) => {
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    // 横幅在写入落定之后异步发出(读设置、读会话名)。
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  beforeAll(async () => {
    await agentHookService.initialize();
    agentStatusWriter.initialize();
    setSessionAgentNotificationCopy({ needsApproval: 'needs approval', needsAnswer: 'needs answer' });
  });
  afterAll(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
  });
  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.banners.length = 0;
    mocks.settings.enabled = true; mocks.settings.sound = true;
    cid = `c${clock}`;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    fixture.sqlite
      .prepare(`INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_seen) VALUES (?, 'p1', 'Fix it', 'codex', 'acp', 'idle', 1)`)
      .run(cid);
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('an ACP session stopping for approval raises one banner; the same wait pushed again does not', async () => {
    await deliver(event('start'));
    await deliver(event('wait', { waitKind: 'approval', waitId: 'w1' }));
    expect(mocks.banners).toEqual([{ title: 'Codex — Fix it', body: 'needs approval', silent: false }]);
    await deliver(event('wait', { waitKind: 'approval', waitId: 'w2' }));
    expect(mocks.banners).toHaveLength(1);
  });

  it('an ACP wait follows the sound switch without losing its banner', async () => {
    mocks.settings.sound = false;
    await deliver(event('start'));
    await deliver(event('wait', { waitKind: 'approval', waitId: 'w1' }));
    expect(mocks.banners).toEqual([{ title: 'Codex — Fix it', body: 'needs approval', silent: true }]);
  });

  it('a disabled notification setting suppresses the wait and its sound', async () => {
    mocks.settings.enabled = false;
    await deliver(event('start'));
    await deliver(event('wait', { waitKind: 'approval', waitId: 'w1' }));
    expect(mocks.banners).toEqual([]);
  });

  it('a terminal hook asking for permission raises it the same way', async () => {
    await deliver(event('start', {}, 'source-1'));
    await deliver(event('notification', { notificationType: 'permission_prompt' as NotificationType }, 'source-1'));
    expect(mocks.banners).toEqual([{ title: 'Codex — Fix it', body: 'needs approval', silent: false }]);
  });

  it('finishing or erroring is a state change and raises nothing', async () => {
    await deliver(event('start'));
    await deliver(event('stop'));
    await deliver(event('start'));
    await deliver(event('error', { message: 'boom' }));
    expect(mocks.banners).toEqual([]);
  });
});
