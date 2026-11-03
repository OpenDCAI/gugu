import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessPresenceFile } from '@gugu/session-core/agents/plugins';
import type { PresenceWatchFs } from '../agent-hooks/presence-interrupt';
import type { AppDb } from '@main/db/client';
import { makeTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, presence: undefined as HarnessPresenceFile | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
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
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('../agent-hooks/notification', () => ({ maybeShowNotification: vi.fn() }));
vi.mock('../agent-hooks/turn-autonomy', () => ({ isSessionAutoApproved: () => false }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn(), on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn((providerId: string) => ({
    capabilities: {
      hooks: providerId === 'gemini'
        ? { kind: 'none' }
        : { kind: 'config', scope: 'workspace', supportedEvents: ['start', 'stop', 'notification', 'error'], presence: { sinceVersion: '2.1.175' } },
    },
    behavior: { hooks: { presence: mocks.presence } },
  })),
  isValidProviderId: vi.fn(() => true),
}));


const { claudePresenceFile } = await import('../../../../../../../packages/session-plugins/src/agents/impl/claude/presence');
mocks.presence = claudePresenceFile;
const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');
const { interruptedTurnKeys } = await import('./interrupted-turns');
const presenceModule = await import('../agent-hooks/presence-interrupt');
const { log } = await import('@main/lib/logger');
const { deferredMessagesSettled, installDeferredMessageDelivery, storeDeferredMessage } = await import('../sessions/session-deferred-messages');
const { setSessionMessageRouter } = await import('../sessions/session-message-router');

type Reconcile = (names: ReadonlySet<string>, deps: {
  fs: PresenceWatchFs;
  isAlive: (pid: number) => boolean;
  spawnEnv: (providerId: string) => Promise<Record<string, string | undefined>>;
}) => Promise<void>;
const tmuxName = (id: string) => makeTmuxSessionName(makePtySessionId('p1', id, id));

describe('U7 boot presence reconciliation through the real SQLite writer and deferred delivery', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let files: Map<string, string>;
  let dead: Set<number>;
  let stopDelivery: (() => void) | undefined;
  const status = (id: string) => fixture.sqlite.prepare(`SELECT agent_status AS status, agent_status_detail AS detail,
    agent_status_seen AS seen FROM sessions WHERE id = ?`).get(id);
  const seed = (id: string, status = 'working', detail: string | null = null, runtime = 'pty', provider = 'claude', providerSessionId: string | null = null) => {
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, provider, runtime, agent_status, agent_status_detail,
      agent_status_seen, provider_session_id, config) VALUES (?, 'p1', ?, ?, ?, ?, 1, ?, json_object('version', '1', 'type', ?, 'agentDisplayName', 'C'))`)
      .run(id, provider, runtime, status, detail, providerSessionId, runtime);
  };
  const presence = (id: string, state: string, pid = 42, filename = pid) =>
    files.set(`/fixture/.claude/sessions/${filename}.json`, JSON.stringify({ pid, sessionId: id, status: state }));
  const boot = async (ids: string[]) => {
    const names = new Set(ids.map(tmuxName));
    await agentStatusWriter.settleAfterRestart(names, 'update');
    // The exact parent has only the existing settle step. Its absence of F1 is
    // exercised as that real boot behaviour, not a missing-export exception.
    const reconcile = Reflect.get(presenceModule, 'reconcileSurvivorsWithPresence') as Reconcile | undefined;
    if (reconcile) await reconcile(names, {
      fs: {
        readdir: async dir => [...files.keys()].filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1)),
        readFile: async path => {
          const text = files.get(path);
          if (text === undefined) throw Object.assign(new Error('missing fixture file'), { code: 'ENOENT' });
          return text;
        },
      },
      isAlive: pid => !dead.has(pid),
      spawnEnv: async () => ({ HOME: '/fixture', CLAUDE_CONFIG_DIR: '/fixture/.claude' }),
    });
  };

  beforeEach(async () => {
    fixture = await openFixture('empty'); mocks.db = fixture.db;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    files = new Map(); dead = new Set(); stopDelivery = undefined;
    vi.clearAllMocks(); agentStatusWriter.initialize();
  });
  afterEach(async () => {
    stopDelivery?.(); setSessionMessageRouter(null);
    agentStatusWriter.dispose(); fixture.close(); mocks.db = undefined;
  });

  it('U1: completes a surviving finished turn normally, unseen, and publishes the corrected reading', async () => {
    seed('survivor', 'working', 'parked', 'pty', 'claude', 'provider-id'); presence('provider-id', 'idle');
    const changes: unknown[] = [], stop = agentStatusWriter.on('agent:status', change => { changes.push(change); });
    try {
      await boot(['survivor']);
      expect(status('survivor')).toEqual({ status: 'idle', detail: 'done', seen: 0 });
      expect(changes).toContainEqual(expect.objectContaining({ sessionId: 'survivor', reading: expect.objectContaining({ status: 'idle', detail: 'done' }), unseen: true }));
      expect(interruptedTurnKeys()).toEqual([]);
    } finally { stop(); }
  });
  it.each([['busy', null], ['shell', 'parked']] as const)('U2: keeps the live %s survivor busy for the supervisor', async (value, detail) => {
    seed('survivor', 'working', detail); presence('survivor', value);
    await boot(['survivor']);
    expect(status('survivor')).toEqual({ status: 'working', detail, seen: 1 });
    expect(interruptedTurnKeys()).toEqual([]);
  });
  it.each(['missing', 'dead', 'wrong-pid', 'malformed', 'wrong-session', 'unsupported'])('U3: preserves the stored reading for %s presence and logs once', async mode => {
    seed('survivor', 'working', 'parked', 'pty', mode === 'unsupported' ? 'gemini' : 'claude');
    if (mode === 'dead') { presence('survivor', 'idle'); dead.add(42); }
    if (mode === 'wrong-pid') presence('survivor', 'idle', 42, 99);
    if (mode === 'malformed') files.set('/fixture/.claude/sessions/42.json', '{broken');
    if (mode === 'wrong-session') presence('another-session', 'idle');
    await boot(['survivor']);
    expect(status('survivor')).toEqual({ status: 'working', detail: 'parked', seen: 1 });
    const entries = [...vi.mocked(log.warn).mock.calls, ...vi.mocked(log.error).mock.calls]
      .filter(([, detail]) => (detail as { sessionId?: string } | undefined)?.sessionId === 'survivor');
    expect(entries).toHaveLength(1);
    expect(interruptedTurnKeys()).toEqual([]);
  });
  it.each([['busy', 'working', 'running', 1], ['waiting', 'needs_user', 'approval', 0]] as const)('U4: corrects stored idle from live %s presence', async (value, result, detail, seen) => {
    seed('survivor', 'idle'); presence('survivor', value);
    await boot(['survivor']);
    expect(status('survivor')).toEqual({ status: result, detail, seen });
  });
  it('U5: does not flush an idle survivor at boot, but does flush on its next actual working edge', async () => {
    seed('survivor'); presence('survivor', 'idle');
    storeDeferredMessage({ sessionId: 'survivor', id: 'deferred', text: 'next real turn' });
    const route = vi.fn(async () => ({ status: 'accepted' as const, messageId: 'deferred', nativeReceiptId: 'receipt' }));
    setSessionMessageRouter(route);
    await boot(['survivor']);
    stopDelivery = installDeferredMessageDelivery(agentStatusWriter);
    await deferredMessagesSettled('survivor');
    expect(route).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare(`SELECT json_extract(metadata, '$.state') AS state FROM messages WHERE id='deferred'`).get())
      .toEqual({ state: 'deferred' });
    agentHookService.emitAgentEvent({ type: 'start', providerId: 'claude', projectId: 'p1', sessionId: 'survivor', timestamp: 1000, payload: {} });
    await vi.waitFor(() => expect(route).toHaveBeenCalledOnce());
    await deferredMessagesSettled('survivor');
  });
  it('U8: continuation records retain only the genuinely lost engines', async () => {
    seed('survivor'); seed('pty-gone'); seed('acp', 'working', null, 'acp'); presence('survivor', 'idle');
    await boot(['survivor']);
    expect(interruptedTurnKeys().sort()).toEqual(['session-interrupted:acp', 'session-interrupted:pty-gone']);
    expect(status('survivor')).toEqual({ status: 'idle', detail: 'done', seen: 0 });
  });
});
