import { installAssistantWorkLedgerHost } from '../../../../sessionpage/assistant-work-ledger';
import { formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionPaneTab } from '@gugu/session-core/session-record/contract';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  startSession: vi.fn(),
  stopSession: vi.fn(),
  /** session-life (owner of ACP sessions): stops and archives are interrupts carrying a reason; restore hands it back. */
  lifeInterrupt: vi.fn(async (_sessionId: string, _event: { k: 'interrupt'; reason: string }): Promise<void> => undefined),
  lifeRestore: vi.fn((_sessionId: string): void => undefined),
  /** Creation turns are admitted as pending rows (enqueue); an empty creation queue is an explicit start. */
  lifeEnqueue: vi.fn((_input: { sessionId: string; messageId: string; text: string; kind: string; turn?: unknown }) => ({ seq: 1, state: 'queued' })),
  lifeStart: vi.fn((_sessionId: string, _origin?: string): void => undefined),
  emit: vi.fn(),
  on: vi.fn(),
  openFileResultListener: undefined as ((result: { requestId: string; success: boolean; error?: string; openedWith?: string | null; tabs?: SessionPaneTab[]; closed?: boolean }) => void) | undefined,
  nextOpenFileResult: { success: true } as { success: boolean; error?: string; openedWith?: string | null; tabs?: SessionPaneTab[]; closed?: boolean },
  stat: vi.fn(),
  workspaces: new Map<string, { path: string; fileSystem: { stat: typeof vi.fn } }>(),
  summaries: {} as Record<string, Record<string, unknown>>,
  ptyStartSession: vi.fn(),
  ptyStopSession: vi.fn(),
  settleSessionExited: vi.fn(async (_params: { sessionId: string; projectId: string }): Promise<void> => undefined),
  sendMessage: vi.fn(),
  readAcceptedMessage: vi.fn(),
  SessionDirectDeliveryError: class SessionDirectDeliveryError extends Error {
    readonly code = 'SESSION_DIRECT_NOT_LIVE';
    constructor(sessionId: string, reason = 'target session is not live') {
      super(`[SESSION_DIRECT_NOT_LIVE] ${reason}: ${sessionId}`);
    }
  },
  recordDeliveredSessionDirectMessage: vi.fn(),
  drainSessionMessageOutbox: vi.fn(),
  /** 挂载着的会话(按会话 id):pty 会话的进程经它起停。 */
  mounted: new Map<string, { sessionPath: string | undefined; sessions: { startSession: unknown; stopSession: unknown; sendMessage: unknown; ownsSession: (id: string) => boolean } }>(),
  ensureSessionMounted: vi.fn(),
  installedExtensions: [] as Array<{
    manifest: { id: string; contributes: { tabs: Array<{ name: string; title?: string; opensFiles?: { session?: string[]; chat?: string[] } }> } };
  }>,
  sessionpageProjectGroup: { kind: 'none', reason: 'no-project' } as
    | { kind: 'group'; projectId: string; groupChatId: string }
    | { kind: 'none'; reason: string },
  sessionpageProjectGroupForSession: vi.fn(),
  localAgentForSession: vi.fn(),
  listLocalModels: vi.fn(),
  listLocalPlatformModels: vi.fn(),
  assertLocalHarnessLaunchable: vi.fn(async (_pluginId: string, _transport: string) => {}),
  resolveProjectWorkspace: vi.fn(),
  /** The new-session box's two reads (`useEffectiveProvider`): the listed agents and which are installed. */
  listAgents: vi.fn(),
  listInstalled: vi.fn(),
  /** 开着的项目(按 id);没在里面 = 项目没打开。 */
  openProjects: new Set<string>(),
  tmuxEnabled: vi.fn(async () => true),
  tmuxSessionNames: new Set<string>(),
  listTmuxSessionNames: vi.fn(),
  killTmuxSession: vi.fn(async (_ctx: unknown, _name: string): Promise<void> => undefined),
  readSessionPreview: vi.fn(async (_sessionId: string): Promise<unknown> => ({
    ok: true,
    value: { running: false, now: null, ended: { kind: 'done', reason: 'end_turn' }, entries: [] },
  })),
}));

vi.mock('@main/core/agents/controller', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/core/agents/controller')>();
  return {
    ...actual,
    agentsController: { ...actual.agentsController, list: () => mocks.listAgents(), listAgentInstallationStatus: () => mocks.listInstalled() },
  };
});

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/acp/controller', () => ({
  peekAcpRuntimeClient: async () => null,
  getAcpRuntimeClient: async () => ({
    startSession: mocks.startSession,
    stopSession: mocks.stopSession,
  }),
}));
vi.mock('@main/core/acp/session-summary-reader', () => ({
  readAcpSessionSummaries: async () => mocks.summaries,
}));
vi.mock('@main/core/agent-hooks/agent-hook-service', () => ({
  agentHookService: { emitAgentEvent: vi.fn() },
}));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({
  agentStatusWriter: {
    birth: vi.fn(async () => undefined),
    settleSessionExited: (params: { sessionId: string; projectId: string }) => mocks.settleSessionExited(params),
  },
}));
vi.mock('@main/core/projects/utils', () => ({
  resolveWorkspace: (_projectId: string, workspaceId: string) => mocks.workspaces.get(workspaceId),
  resolveSession: (_projectId: string, sessionId: string) => mocks.mounted.get(sessionId) ?? null,
}));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: (projectId: string) => (mocks.openProjects.has(projectId) ? { settings: {} } : null) },
}));
vi.mock('@main/core/projects/settings/resolve-tmux-enabled', () => ({ resolveTmuxEnabled: () => mocks.tmuxEnabled() }));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { ensureSessionMounted: mocks.ensureSessionMounted },
}));
vi.mock('@main/core/pty/tmux-session-name', () => ({
  killTmuxSession: (ctx: unknown, name: string) => mocks.killTmuxSession(ctx, name),
  listTmuxSessionNames: () => mocks.listTmuxSessionNames(),
  makeTmuxSessionName: (ptySessionId: string) => `tmux:${ptySessionId}`,
  decodeTmuxSessionName: (name: string) => (name.startsWith('tmux:') ? name.slice('tmux:'.length) : null),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit, on: mocks.on } }));
vi.mock('@main/core/sessions/session-life', () => ({ sessionLife: () => ({
  interrupt: mocks.lifeInterrupt, restore: mocks.lifeRestore, enqueue: mocks.lifeEnqueue, start: mocks.lifeStart,
}) }));
/** The creation turns session-life was handed for this session (admitCreationTurns' observable effect). */
const admittedTurns = (sessionId: string) => mocks.lifeEnqueue.mock.calls.map(([input]) => input).filter((input) => input.sessionId === sessionId);
/** Nothing started this session: no direct ACP runtime start, no admitted creation turn, no explicit Life start. */
function expectNothingStarted(): void {
  expect(mocks.startSession).not.toHaveBeenCalled();
  expect(mocks.lifeEnqueue).not.toHaveBeenCalled();
  expect(mocks.lifeStart).not.toHaveBeenCalled();
}
/** Sessions session-life was asked to interrupt for `reason`, in call order. */
const interruptedFor = (reason: string) => mocks.lifeInterrupt.mock.calls
  .filter(([, event]) => event.reason === reason).map(([sessionId]) => sessionId);
vi.mock('./sendMessage', () => ({
  sendMessage: mocks.sendMessage,
  readAcceptedMessage: mocks.readAcceptedMessage,
  recordDeliveredSessionDirectMessage: mocks.recordDeliveredSessionDirectMessage,
  drainSessionMessageOutbox: mocks.drainSessionMessageOutbox,
  SessionDirectDeliveryError: mocks.SessionDirectDeliveryError,
}));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({
  sessionpageProjectGroupForSession: mocks.sessionpageProjectGroupForSession,
  localAgentForSession: mocks.localAgentForSession,
}));
// 点名项目 → 项目根工作区那一步(登记 / 打开项目)由 create-session 自己的测试判;这里只看编排把谁交给它、落在哪。
vi.mock('../session-timeline/create-session', () => ({ resolveProjectWorkspace: mocks.resolveProjectWorkspace }));
vi.mock('@main/core/session-timeline/preview-rpc', () => ({ readSessionPreview: mocks.readSessionPreview }));
vi.mock('../extensions/extensions-root', () => ({
  extensionsService: () => ({
    list: () => ({ extensions: mocks.installedExtensions, invalid: [] }),
  }),
}));
vi.mock('../agents/session-discovery', async () => ({
  ...(await vi.importActual('../agents/session-discovery')),
  listLocalModels: (...args: unknown[]) => mocks.listLocalModels(...args),
  listLocalPlatformModels: (...args: unknown[]) => mocks.listLocalPlatformModels(...args),
  // 启动那道闸要起真的版本探针、解析真的可执行文件;这里只判编排在闸之后做什么。
  assertLocalHarnessLaunchable: (pluginId: string, transport: string) => mocks.assertLocalHarnessLaunchable(pluginId, transport),
}));

import {
  sessionOpenBrowserInPaneChannel,
  sessionOpenExtensionInPaneChannel,
  sessionOpenFileInPaneChannel,
} from '@shared/events/appEvents';
import {
  sessionPlatformModel,
  recordSessionPlatformModel,
} from './platform-model-selection';
import { restoreSession } from './archiveSession';
import { getSessions } from './getSessions';
import { takeBirthGroup } from './birth-groups';
import { recordChildHarnessDefault } from './child-harness-default';
import type { NewSessionMemory } from '@shared/core/app-settings';
import { getPlugin } from '../agents/plugin-registry';
import { appSettingsService } from '@main/core/settings/settings-service';
import {
  messageSessionFrom,
  runRemoteSessionAction,
  runSessionAction,
  spawnSessionForApp,
  setRemotePaneOpener,
  stopExactSessionpageSession,
  type SessionCallerContext,
} from './session-orchestration';
import type { RemoteSessionCaller, SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { setOtherMachines, type OtherMachines } from './session-family';
import {
  REMOTE_PANE_NO_EXTENSIONS,
  REMOTE_PANE_PAGE_NOT_FILE,
  REMOTE_PANE_QUEUED_NOTE,
  RemotePaneError,
  describeOutsideWorkspace,
  describePageOutsideWorkspace,
} from '../session-timeline/remote-pane';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('session orchestration', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const context: SessionCallerContext = {
    sessionId: 'caller',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.startSession.mockReset();
    mocks.stopSession.mockReset();
    mocks.lifeInterrupt.mockReset();
    mocks.lifeInterrupt.mockResolvedValue(undefined);
    mocks.lifeRestore.mockReset();
    mocks.lifeEnqueue.mockClear();
    mocks.lifeStart.mockClear();
    mocks.emit.mockReset();
    mocks.on.mockReset();
    mocks.openFileResultListener = undefined;
    mocks.nextOpenFileResult = { success: true };
    mocks.on.mockImplementation((_channel: { name?: string }, listener) => {
      mocks.openFileResultListener = listener;
      return () => {
        if (mocks.openFileResultListener === listener) mocks.openFileResultListener = undefined;
      };
    });
    mocks.emit.mockImplementation((_channel, request) => {
      if (!request || typeof request !== 'object' || !('requestId' in request)) return;
      queueMicrotask(() => {
        mocks.openFileResultListener?.({
          requestId: String(request.requestId),
          ...mocks.nextOpenFileResult,
        });
      });
    });
    mocks.stat.mockReset();
    mocks.stat.mockImplementation(async (path: string) => ({
      success: true,
      data: { path, type: path.endsWith('/directory') ? 'directory' : 'file', size: 1 },
    }));
    mocks.startSession.mockResolvedValue({ success: true, data: { providerSessionId: 'native-child' } });
    mocks.stopSession.mockResolvedValue({ success: true, data: undefined });
    mocks.workspaces.clear();
    mocks.summaries = {};
    mocks.ptyStartSession.mockReset();
    mocks.ptyStopSession.mockReset();
    mocks.sendMessage.mockReset();
    mocks.localAgentForSession.mockReset();
    mocks.localAgentForSession.mockResolvedValue(null);
    mocks.listLocalModels.mockReset();
    mocks.listLocalModels.mockResolvedValue({ models: [] });
    mocks.listLocalPlatformModels.mockReset();
    mocks.listLocalPlatformModels.mockResolvedValue({
      models: [],
      meta: { available: false, reason: null },
    });
    mocks.recordDeliveredSessionDirectMessage.mockReset();
    mocks.drainSessionMessageOutbox.mockReset();
    mocks.sendMessage.mockResolvedValue({ id: 'delegation', status: 'accepted' });
    mocks.ptyStartSession.mockResolvedValue(undefined);
    mocks.ptyStopSession.mockResolvedValue(undefined);
    mocks.sessionpageProjectGroup = { kind: 'none', reason: 'no-project' };
    mocks.sessionpageProjectGroupForSession.mockReset();
    mocks.sessionpageProjectGroupForSession.mockImplementation(async () => mocks.sessionpageProjectGroup);
    mocks.mounted.clear();
    mocks.resolveProjectWorkspace.mockReset();
    mocks.resolveProjectWorkspace.mockImplementation(async (input: unknown) => ({
      ok: false,
      error: { code: 'project_not_found', message: `unexpected project resolution ${JSON.stringify(input)}` },
    }));
    mocks.ensureSessionMounted.mockReset();
    mocks.ensureSessionMounted.mockImplementation(async (sessionId: string) => {
      const workspaceId = workspaceOf(sessionId);
      const workspace = workspaceId ? mocks.workspaces.get(workspaceId) : undefined;
      if (!workspaceId || !workspace) throw new Error(`test session ${sessionId} has no mounted workspace`);
      mount(sessionId);
      return { path: workspace.path, workspaceId };
    });
    mocks.workspaces.set('workspace-1', { path: '/repo/ws-1', fileSystem: { stat: mocks.stat } });
    mocks.workspaces.set('workspace-2', { path: '/repo/ws-2', fileSystem: { stat: mocks.stat } });

    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project 1', '/repo');
      INSERT INTO projects (id, name, path) VALUES ('project-2', 'Project 2', '/other');
      INSERT INTO workspaces (id, type, path) VALUES ('workspace-1', 'local', '/repo/ws-1');
      INSERT INTO workspaces (id, type, path) VALUES ('workspace-2', 'local', '/repo/ws-2');
      INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
        VALUES ('caller', 'project-1', 'workspace-1', 'Caller', 'codex', 'acp');
    `);
    mount('caller');
  });

  afterEach(() => {
    setOtherMachines(null);
    fixture.close();
    mocks.db = undefined;
    vi.unstubAllEnvs();
  });

  /** 这条会话的标题与「显式命名过的那个名字」——后者只在 config 上,前者两种来源同形。 */
  function namedRow(sessionId: string) {
    const row = fixture.sqlite.prepare(
      `SELECT title, config FROM sessions WHERE id = ?`
    ).get(sessionId) as { title: string; config: string | null };
    const config = row.config ? (JSON.parse(row.config) as { agentDisplayName?: string }) : {};
    return { title: row.title, agentDisplayName: config.agentDisplayName };
  }

  /** The envelope the last ACP child was started with — its delegation travels in the start (#6497). */
  function lastAcpDelegationEnvelope() {
    return mocks.recordDeliveredSessionDirectMessage.mock.calls.at(-1)![1].text as string;
  }

  function childRows() {
    return fixture.sqlite.prepare(
      `SELECT id, workspace_id, parent_session_id, spawned_by_session_id
       FROM sessions WHERE id != 'caller' ORDER BY created_at, id`
    ).all() as Array<{ id: string; workspace_id: string | null; parent_session_id: string | null; spawned_by_session_id: string | null }>;
  }

  async function expectFailedChildToRestore(sessionId: string) {
    const child = { id: sessionId, workspace_id: 'workspace-1', parent_session_id: 'caller', spawned_by_session_id: 'caller' };
    await vi.waitFor(() => {
      expect(fixture.sqlite.prepare('SELECT id, archived_at FROM sessions WHERE id = ?').get(sessionId))
        .toEqual({ id: sessionId, archived_at: expect.any(String) });
    });
    expect(childRows()).toEqual([child]);
    expect((await getSessions()).map(session => session.id)).not.toContain(sessionId);
    expect((await getSessions({ includeArchived: true })).find(session => session.id === sessionId)).toMatchObject({
      id: sessionId, projectId: 'project-1', workspaceId: 'workspace-1', archivedAt: expect.any(String),
      parentSessionId: 'caller', spawnedBySessionId: 'caller',
    });
    const started = mocks.startSession.mock.calls.length;
    await expect(restoreSession('project-1', sessionId)).resolves.toMatchObject({
      id: sessionId, projectId: 'project-1', workspaceId: 'workspace-1', archivedAt: null,
    });
    expect(childRows()).toEqual([child]);
    expect((await getSessions()).map(session => session.id)).toContain(sessionId);
    expect(fixture.sqlite.prepare('SELECT archived_at FROM sessions WHERE id = ?').get('caller'))
      .toEqual({ archived_at: null });
    expect(mocks.startSession).toHaveBeenCalledTimes(started);
    // The compensation archives through session-life (never a direct runtime stop) and Restore hands it back dormant.
    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(interruptedFor('archive')).toEqual([sessionId]);
    expect(mocks.lifeRestore).toHaveBeenCalledExactlyOnceWith(sessionId);
    // A child cancelled before its start never had its creation turn admitted, and Restore does not start it.
    expect(mocks.lifeEnqueue).not.toHaveBeenCalled();
    expect(mocks.lifeStart).not.toHaveBeenCalled();
  }

  /** 这条会话挂载好了:pty 会话的进程经这个 provider 起停。 */
  function mount(sessionId: string): void {
    const workspaceId = workspaceOf(sessionId);
    mocks.mounted.set(sessionId, {
      sessionPath: workspaceId ? mocks.workspaces.get(workspaceId)?.path : undefined,
      sessions: {
        startSession: mocks.ptyStartSession,
        stopSession: mocks.ptyStopSession,
        sendMessage: vi.fn(),
        ownsSession: () => true,
      },
    });
  }

  /** project-2 的根工作区:点名项目时 resolveProjectWorkspace 交回的那一个。 */
  function project2Root(): void {
    fixture.sqlite.exec(`INSERT INTO workspaces (id, type, path) VALUES ('workspace-p2', 'local', '/other')`);
    mocks.workspaces.set('workspace-p2', { path: '/other', fileSystem: { stat: mocks.stat } });
    mocks.resolveProjectWorkspace.mockResolvedValue({ ok: true, value: { projectId: 'project-2', repositoryWorkspaceId: 'workspace-p2' } });
  }

  function workspaceOf(sessionId: string): string | null {
    const row = fixture.sqlite
      .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
      .get(sessionId) as { workspace_id: string | null } | undefined;
    return row?.workspace_id ?? null;
  }

  function insertPtyChild(
    id = 'pty-child',
    status = 'working',
    parentSessionId: string | null = null,
  ): void {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime, agent_status,
           spawned_by_session_id, parent_session_id)
         VALUES (?, 'project-1', 'workspace-1', 'Terminal child', 'claude', 'pty', ?, 'caller', ?)`
      )
      .run(id, status, parentSessionId);
    mount(id);
  }

  /**
   * stop 那一端交给状态写入者的「被打断」(真实产品里是 stopSession → settleSessionExited)。
   * 本文件把 pty provider 整个桩掉了,所以这里直接写写入者会落下的那一句 —— **写**那一端由
   * `impl/session-provider-respawn.test.ts` 判,两边合起来才是一条链。
   */
  function markInterrupted(id: string): void {
    fixture.sqlite
      .prepare("UPDATE sessions SET agent_status = 'idle', agent_status_detail = 'plain' WHERE id = ?")
      .run(id);
  }

  // 真源 §4 F16(10-01):这台电脑上的 App 告诉一条会话一件事,与 session_message 的 session: 腿同一条投递,信封由 App 那一侧给。
  // 对照组(父提交 9951620de):App 走聊天(写一条悄悄话),根本不经过这一层。
  describe('from a sender that is not a session (messageSessionFrom)', () => {
    const envelope = (messageId: string, text: string) => `<app-envelope msg="${messageId}">${text}</app-envelope>`;

    it('delivers session-direct in the bytes its envelope makes, with no caller session', async () => {
      mocks.sendMessage.mockResolvedValueOnce({ id: 'm1', status: 'delivered' });
      expect(await messageSessionFrom(envelope, 'caller', ' keep warm ', { keyScope: 'app:lens' })).toEqual({ id: 'm1' });
      const sent = mocks.sendMessage.mock.calls.at(-1)![0] as { sessionId: string; clientMessageId: string; text: string; kind: string };
      expect(sent).toMatchObject({ sessionId: 'caller', kind: 'session-direct' });
      expect(sent.text).toBe(`<app-envelope msg="${sent.clientMessageId}">keep warm</app-envelope>`);
    });

    it('keeps a scheduled retry on the stored receipt and preserves its original envelope', async () => {
      const receipt = { id: '022ebf62-18b2-4d78-987e-ddb02dd04c46', at: '2026-10-26T07:00:00.000Z' };
      mocks.sendMessage.mockRejectedValueOnce(new mocks.SessionDirectDeliveryError('caller', 'preparation unavailable'));
      await expect(messageSessionFrom(envelope, 'caller', 'first text', { keyScope: 'automation:one', receipt }))
        .rejects.toMatchObject({ code: 'SESSION_DIRECT_NOT_LIVE' });
      const first = mocks.sendMessage.mock.calls.at(-1)![0] as { clientMessageId: string; text: string };
      mocks.readAcceptedMessage.mockReturnValueOnce({ id: first.clientMessageId, sessionId: 'caller', content: first.text });
      mocks.sendMessage.mockResolvedValueOnce({ id: first.clientMessageId, status: 'delivered' });
      await expect(messageSessionFrom(() => 'changed envelope', 'caller', 'changed text', { keyScope: 'automation:one', receipt }))
        .resolves.toEqual({ id: first.clientMessageId });
      const second = mocks.sendMessage.mock.calls.at(-1)![0] as { clientMessageId: string; text: string };
      expect(second.clientMessageId).toBe(first.clientMessageId);
      expect(second.text).toBe(first.text);
    });

    it('a session that does not take it, or is not here: thrown with the reason', async () => {
      mocks.sendMessage.mockRejectedValueOnce(new mocks.SessionDirectDeliveryError('caller', 'target session could not be woken (gone)'));
      await expect(messageSessionFrom(envelope, 'caller', 'keep warm', { keyScope: 'app:lens' })).rejects.toThrow(/could not be woken/);
      await expect(messageSessionFrom(envelope, 'nobody', 'hi', { keyScope: 'app:lens' })).rejects.toThrow(/session not found/);
    });
  });

  // 排队 / 附带 / 同键替换是 App 的 `messageAgent` 走的那一条投递路上的参数(owner 10-09:agent 之间的 session_message
  // 只留默认插话,它的 schema 拒这几个字段,见 guguSessionMcp 测试)。编排层只做两件事:key 按发信方加前缀(两个发信方
  // 的同名 key 互不替换);排队碰到终端会话在任何投递之前拒绝。忙闲与替换本身归会话机(emdash-agent-registry / machine.ts),
  // 附带的存与冲归 session-deferred-messages。对照组(父提交 b3c2e3f03):action 上没有 delivery / key,sendMessage 收到的参数里也没有。
  describe('an App\'s queue / defer / key (messageAgent)', () => {
    const envelope = (messageId: string, text: string) => `<env msg="${messageId}">${text}</env>`;
    const app = { keyScope: 'app:lens' };
    beforeEach(() => {
      fixture.sqlite.exec(`
        INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
          VALUES ('peer', 'project-1', 'workspace-1', 'Peer', 'codex', 'acp');
        INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
          VALUES ('term', 'project-1', 'workspace-1', 'Term', 'codex', 'pty');
      `);
      mocks.sendMessage.mockImplementation(async (params: { clientMessageId: string }) => ({ id: params.clientMessageId, status: 'delivered' }));
    });
    const sentDelivery = () => (mocks.sendMessage.mock.calls.at(-1)![0] as { delivery?: unknown }).delivery;

    it.each([undefined, 'queue', 'defer'] as const)('refuses archived direct delivery %s before sending or storing local debt', async (delivery) => {
      fixture.sqlite.prepare("UPDATE sessions SET archived_at='2026-10-28T09:00:00Z' WHERE id='peer'").run();
      await expect(messageSessionFrom(envelope, 'peer', 'Archive marker', { ...(delivery ? { delivery } : {}), ...app }))
        .rejects.toMatchObject({ code: 'SESSION_ARCHIVED' });
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(fixture.sqlite.prepare("SELECT id FROM messages WHERE session_id='peer'").all()).toEqual([]);
      expectNothingStarted();
    });

    it('hands queue to the delivery, with the key scoped to the App', async () => {
      await messageSessionFrom(envelope, 'peer', 'paper 5', { delivery: 'queue', key: 'paper', ...app });
      expect(sentDelivery()).toEqual({ queue: true, coalesceKey: 'app:lens:paper' });
    });

    it('sends no delivery when none was asked for', async () => {
      await messageSessionFrom(envelope, 'peer', 'hi', app);
      expect(sentDelivery()).toBeUndefined();
    });

    it('refuses queue to a terminal session before sending anything', async () => {
      await expect(messageSessionFrom(envelope, 'term', 'x', { delivery: 'queue', ...app }))
        .rejects.toThrow(/session:term is a terminal session: delivery "queue" is not supported there/);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a key without queue or defer', async () => {
      await expect(messageSessionFrom(envelope, 'peer', 'x', { key: 'paper', ...app }))
        .rejects.toThrow(/key replaces a message that is still waiting/);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    // owner 10-14:App 页面由 agent 操作时,发信的是它的会话(`from`)—— 同 session_message,它不能发给自己。
    it('told from the session of the agent that works the page: it cannot tell itself', async () => {
      await expect(messageSessionFrom(envelope, 'peer', 'x', { from: 'peer', ...app })).rejects.toThrow(/session cannot message itself/);
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      await messageSessionFrom(envelope, 'peer', 'x', { from: 'term', ...app });
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    });

    // 附带:目标不在运行中 ⇒ 不送、不叫醒,存一行「已附带」(终端照收,投递是现成那条路);在运行中 ⇒ 当场按普通发送投出。
    const deferredRows = () => fixture.sqlite
      .prepare("SELECT session_id, content, json_extract(metadata, '$.state') AS state, json_extract(metadata, '$.key') AS key FROM messages")
      .all() as Array<{ session_id: string; content: string; state: string; key: string | null }>;

    it('keeps a deferred message for an idle session without sending it, its key scoped to the App, a terminal one too', async () => {
      expect(await messageSessionFrom(envelope, 'peer', 'paper 5', { delivery: 'defer', key: 'paper', ...app }))
        .toEqual({ id: expect.any(String), deferred: true });
      expect(await messageSessionFrom(envelope, 'term', 'paper 5', { delivery: 'defer', key: 'paper', ...app }))
        .toEqual({ id: expect.any(String), deferred: true });
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(deferredRows().map((row) => [row.session_id, row.state, row.key])).toEqual([
        ['peer', 'deferred', 'app:lens:paper'],
        ['term', 'deferred', 'app:lens:paper'],
      ]);
      expect(deferredRows()[0]!.content).toContain('paper 5');
    });

    it('sends a deferred message at once, the ordinary way, to a session already working', async () => {
      fixture.sqlite.prepare("UPDATE sessions SET agent_status = 'working' WHERE id = 'peer'").run();
      expect(await messageSessionFrom(envelope, 'peer', 'now', { delivery: 'defer', ...app })).toEqual({ id: expect.any(String) });
      expect(sentDelivery()).toBeUndefined();
      expect(deferredRows()).toEqual([]);
    });
  });

  // R 第 3 段(真源原则 13):App 起 agent 走 session_spawn 那一条起会话的路;没点名的照这个人上次自己新建的那条会话,
  // ❌ 不看页面开在哪条会话旁边。对照组(父提交 1a60bdbf45):extension-agents 自己那份继承,从页面所在的那条会话起。
  describe('an App starts a session (spawnSessionForApp)', () => {
    const envelope = (messageId: string, text: string) => `<app-envelope msg="${messageId}">${text}</app-envelope>`;
    /** Settings' default agent, and the new-session memory (`newSessionMemory`) — what the box reads; its shape stands in for the terminal setting. */
    let defaultAgent: string | null = null;
    let memory: NewSessionMemory = { lastPicked: null, lastStarted: null, sessionView: 'code' };
    let settingsSpy: { mockRestore(): void } | undefined;
    const installed = (...ids: string[]) =>
      mocks.listInstalled.mockImplementation(async () => ids.map((id) => ({ id, status: 'available' })));
    beforeEach(() => {
      defaultAgent = null;
      memory = { lastPicked: null, lastStarted: null, sessionView: 'code' };
      mocks.listAgents.mockImplementation(async () =>
        ['codex', 'claude'].map((id) => ({ id, capabilities: { sessionpage: getPlugin(id).capabilities.sessionBundle.sessionpage } })),
      );
      installed('codex', 'claude');
      const realGet = appSettingsService.get.bind(appSettingsService);
      settingsSpy = vi
        .spyOn(appSettingsService, 'get')
        .mockImplementation(((key: string) => (key === 'defaultAgent' ? Promise.resolve(defaultAgent) : key === 'newSessionMemory' ? Promise.resolve(memory) : key === 'terminal' ? realGet('terminal').then((t) => ({ ...t, enabled: memory.sessionView === 'code' })) : realGet(key as never))) as never);
    });
    afterEach(() => settingsSpy?.mockRestore());
    function appRow(id: string) {
      return fixture.sqlite.prepare('SELECT provider, runtime, project_id, workspace_id, spawned_by_extension_id, parent_session_id FROM sessions WHERE id = ?').get(id);
    }

    it('starts on the explicitly named computer through the existing App RPC, without a local task', async () => {
      const appSpawn = vi.fn<OtherMachines['appSpawn']>(async () => ({ agentId: 'user:remote-agent' }));
      setOtherMachines({
        devices: async () => [], isThisDevice: async () => false, appSpawn,
        sessions: async () => ({ sessions: [], unreached: [] }), archive: vi.fn(),
        appMessage: vi.fn(), appReadFile: vi.fn(), appCall: vi.fn(),
      });
      try {
        expect(await spawnSessionForApp({ extensionId: 'context', extensionName: 'Context', envelope, prompt: 'inspect', device: 'device:remote', project: '/remote/project', harness: 'codex' })).toEqual({ agentId: 'user:remote-agent' });
        expect(appSpawn).toHaveBeenCalledWith({ extensionId: 'context', extensionName: 'Context' }, 'remote', {
          action: 'spawn', prompt: 'inspect', spawn: expect.objectContaining({ project: '/remote/project', harness: 'codex' }),
        });
        expect(appSpawn.mock.calls[0]?.[2]?.spawn).not.toHaveProperty('device');
      } finally { setOtherMachines(null); }
    });

    it('naming nothing: the engine and shape the new-session memory holds — in the home project; started before it answers', async () => {
      project2Root();
      memory = { lastPicked: null, lastStarted: { provider: 'codex', providerChosenByUser: true }, sessionView: 'general' };
      const row = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: ' keep it warm ' });
      expect(mocks.resolveProjectWorkspace).toHaveBeenCalledWith({ projectId: undefined, projectPath: '' });
      expect(appRow(row.id)).toEqual({
        provider: 'codex',
        runtime: 'acp',
        project_id: 'project-2',
        workspace_id: 'workspace-p2',
        spawned_by_extension_id: 'board',
        parent_session_id: null,
      });
      // Admitted before it answers: the App's envelope is the session's first pending row (session-life starts it).
      expect(mocks.startSession).not.toHaveBeenCalled();
      expect(admittedTurns(row.id)).toEqual([expect.objectContaining({ text: lastAcpDelegationEnvelope(), kind: 'ordinary' })]);
      expect(lastAcpDelegationEnvelope()).toMatch(/^<app-envelope msg="[^"]+">keep it warm<\/app-envelope>$/);
    });

    it('naming harness, transport and project: that, there; born in the chat it names', async () => {
      project2Root();
      const row = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x', harness: 'codex', transport: 'pty', project: 'project-2', chat: 'chat-7' });
      expect(mocks.resolveProjectWorkspace).toHaveBeenCalledWith({ projectId: 'project-2', projectPath: '' });
      expect(appRow(row.id)).toMatchObject({ provider: 'codex', runtime: 'pty', project_id: 'project-2' });
      // An App's agent is pulled into its chat on purpose: an ordinary seat, not a task seat.
      expect(takeBirthGroup(row.id)).toEqual({ chatId: 'chat-7', asTask: false });
    });

    // owner 10-14: started from a page an agent works — spawned by that agent, by session_spawn's rule (its child, whatever
    // project it lands in: owner 2026-10-30), and still the App's own agent.
    it('for the agent that works the page: spawned by it, its child even in a named project; still the App\'s', async () => {
      project2Root();
      const relationsOf = (id: string) => fixture.sqlite.prepare('SELECT spawned_by_session_id, parent_session_id, spawned_by_extension_id FROM sessions WHERE id = ?').get(id);
      const child = await spawnSessionForApp({ extensionId: 'board', bySession: 'caller', envelope, prompt: 'x' });
      expect(relationsOf(child.id)).toEqual({ spawned_by_session_id: 'caller', parent_session_id: 'caller', spawned_by_extension_id: 'board' });
      const placed = await spawnSessionForApp({ extensionId: 'board', bySession: 'caller', envelope, prompt: 'x', project: 'project-2' });
      expect(relationsOf(placed.id)).toEqual({ spawned_by_session_id: 'caller', parent_session_id: 'caller', spawned_by_extension_id: 'board' });
    });

    // 125 (10-06 02:06): one choice for a new session, the box's (`resolveSessionProviderSelection`), wherever it
    // starts. Control (a8c9bb2450): only the last-started session counted — settings' default agent was ignored, and with
    // no history it refused where the box picks one.
    it('the box\'s order: the engine last started by the person (codex) over settings\' default (claude); with nothing remembered, the default', async () => {
      project2Root();
      defaultAgent = 'claude';
      memory = { lastPicked: null, lastStarted: { provider: 'codex', providerChosenByUser: true }, sessionView: 'code' };
      const remembered = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(appRow(remembered.id)).toMatchObject({ provider: 'codex' });
      memory = { lastPicked: null, lastStarted: null, sessionView: 'code' };
      const byDefault = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(appRow(byDefault.id)).toMatchObject({ provider: 'claude' });
    });

    // L11 复核 58 (125 10-06 05:01): the box does not count an engine it guessed (the factory preference) as memory; main took
    // the newest session's engine as memory, so a guessed claude outranked settings' codex there and not in the box. Control
    // (a8cac3652b): read the newest row — claude.
    it('an engine the box only guessed is no memory: settings\' default (codex) wins over a guessed claude, as in the box', async () => {
      project2Root();
      defaultAgent = 'codex';
      memory = { lastPicked: null, lastStarted: { provider: 'claude', providerChosenByUser: false }, sessionView: 'code' };
      const row = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(appRow(row.id)).toMatchObject({ provider: 'codex' });
      // Picked by hand earlier, started as a guess since: the hand pick is the memory.
      memory = { ...memory, lastPicked: 'claude' };
      const picked = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(appRow(picked.id)).toMatchObject({ provider: 'claude' });
    });

    it('on the engine last started, the model it started with — a platform model this computer still offers', async () => {
      project2Root();
      mocks.listLocalPlatformModels.mockResolvedValue({ models: [{ id: 'platform:gpt-5.6-luna' }], meta: { available: true, reason: null } });
      memory = { lastPicked: null, lastStarted: { provider: 'codex', platformModel: 'gpt-5.6-luna', providerChosenByUser: true }, sessionView: 'code' };
      const row = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(await sessionPlatformModel(row.id)).toMatchObject({ modelId: 'gpt-5.6-luna' });
      // One no longer offered: the engine's own default, as the box drops it.
      memory = { ...memory, lastStarted: { provider: 'codex', platformModel: 'gone-model', providerChosenByUser: true } };
      const fallback = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(await sessionPlatformModel(fallback.id)).toBeNull();
    });

    it('nothing remembered, no default: the box\'s pick of what is installed (Codex first); nothing usable: said, and nothing made', async () => {
      project2Root();
      installed('claude', 'codex');
      const picked = await spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' });
      expect(appRow(picked.id)).toMatchObject({ provider: 'codex' });
      fixture.sqlite.exec(`DELETE FROM sessions WHERE id = '${picked.id}'`);
      installed();
      await expect(spawnSessionForApp({ extensionId: 'board', envelope, prompt: 'x' })).rejects.toThrow(/no agent on this computer can start a session/);
      expect(childRows()).toEqual([]);
    });
  });

  // agent 的 session_* 跨机器(owner 2026-09-30 拍板):别的机器上的会话交给这台执行的动作。
  // 可见域:编排层的 runRemoteSessionAction(真 SQLite,引擎与 task 服务是替身);设备 RPC 那一段在 crossMachineSessions 的单测里。
  describe('from another machine (runRemoteSessionAction)', () => {
    const remoteCaller: RemoteSessionCaller = {
      deviceId: 'device-a',
      deviceLabel: 'mac1',
      sessionId: 'remote-caller',
      agentUserId: 'agent-remote',
      name: 'Claude 7',
      harness: 'codex',
      transport: 'acp',
      model: null,
      platformModel: null,
    };

    function configOf(sessionId: string): Record<string, unknown> {
      const row = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(sessionId) as { config: string | null };
      return row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
    }

    it('prepares one stable dormant account-work seat without delivering or starting its first turn', async () => {
      project2Root();
      const stop=installAssistantWorkLedgerHost({context:async()=>({ownerId:'owner',runtimeInstanceId:'runtime',deviceId:'device-b',client:{rpc:async()=>({data:null,error:null})}}),kick:()=>{}});
      const intent={version:1 as const,assistant_id:'10000000-0000-4000-8000-000000000001',work_id:'10000000-0000-4000-8000-000000000002',operation_id:'10000000-0000-4000-8000-000000000003',message_id:'10000000-0000-4000-8000-000000000004',child_session_id:'10000000-0000-4000-8000-000000000005',coordinator:{session_id:'remote-caller',device_id:'device-a'},title:'Task',continuation:false};
      try {
        const action={action:'spawn' as const,prompt:'Run after account acceptance',project_id:'project-2',assistant_work:intent};
        const first=await runRemoteSessionAction(remoteCaller,action) as {session_id:string;assistant_work_target:unknown};
        expect(first.session_id).toBe(intent.child_session_id);
        expect(first.assistant_work_target).toMatchObject({session_id:intent.child_session_id,device_id:'device-b'});
        await runRemoteSessionAction(remoteCaller,action);
        expect(childRows()).toHaveLength(1);
        expectNothingStarted();
        expect(mocks.ptyStartSession).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.recordDeliveredSessionDirectMessage).not.toHaveBeenCalled();
      } finally {stop();}
    });

    it('spawns a child nested under the caller on the other machine, recorded in config, and answers to its session id', async () => {
      project2Root();
      const result = (await runRemoteSessionAction(remoteCaller, {
        action: 'spawn',
        prompt: 'Train the model on this box.',
        project_id: 'project-2',
      })) as {
        session_id: string;
        parent_session_id: string | null;
        spawned_by_session_id: string | null;
        spawned_by_device_id?: string;
        message_route?: unknown;
      };

      // 挂在发起会话下(owner 2026-10-01):它在别的机器上,本机的两个外键装不下,记在 config。
      expect(result.parent_session_id).toBe('remote-caller');
      expect(result.spawned_by_session_id).toBe('remote-caller');
      expect(result.spawned_by_device_id).toBe('device-a');
      expect(childRows()).toEqual([
        expect.objectContaining({ id: result.session_id, parent_session_id: null, spawned_by_session_id: null }),
      ]);
      expect(configOf(result.session_id).spawnedByRemote).toEqual({
        deviceId: 'device-a',
        sessionId: 'remote-caller',
        agentUserId: 'agent-remote',
        name: 'Claude 7',
      });
      // 挂在谁下面单记一格(与 session_set_parent 同一种存法);spawnedByRemote 只记来历。
      expect(configOf(result.session_id).parentRemote).toEqual({ deviceId: 'device-a', sessionId: 'remote-caller' });
      // 工作目录是点名的那个项目的根工作区。
      expect(childRows()[0]!.workspace_id).toBe('workspace-p2');
      // 往来只有点对点:两边不在同一个项目群里。
      expect(result.message_route).toEqual({ tool: 'session_message', to: [`session:${result.session_id}`] });
      // 首句信封:发信人带机器名,地址是发起方的 session:(跨机器回得来)。
      const envelope = lastAcpDelegationEnvelope();
      expect(envelope).toContain('from="Claude 7 · mac1"');
      expect(envelope).toContain('from_id="session:remote-caller"');
      expect(envelope).toContain('Train the model on this box.');
      // Its start is session-life's: the delegation is admitted as the first pending row; the start reads the
      // session row, which carries the project and the unattended permission mode.
      expect(admittedTurns(result.session_id)).toEqual([expect.objectContaining({ text: envelope })]);
      expect(mocks.startSession).not.toHaveBeenCalled();
      expect((await getSessions()).find((session) => session.id === result.session_id)).toMatchObject({
        projectId: 'project-2',
        permissionMode: 'full-access',
      });
    });

    it('keeps a child unnested when asked — the same choice as on one machine', async () => {
      project2Root();
      const flat = (await runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x', parent_session_id: null })) as { session_id: string; parent_session_id: string | null };
      expect(flat.parent_session_id).toBeNull();
      expect(configOf(flat.session_id)).not.toHaveProperty('parentRemote');
    });

    it('lets a remote spawner choose a parent on the receiving machine without changing provenance', async () => {
      project2Root();
      const child = await runRemoteSessionAction(remoteCaller, {
        action: 'spawn', prompt: 'x', project_id: 'project-2', parent_session_id: 'caller',
      }) as { session_id: string; parent_session_id: string | null; spawned_by_session_id: string };
      expect(child).toMatchObject({ parent_session_id: 'caller', spawned_by_session_id: 'remote-caller' });
      expect(fixture.sqlite.prepare('SELECT parent_session_id, spawned_by_session_id, project_id FROM sessions WHERE id = ?').get(child.session_id))
        .toEqual({ parent_session_id: 'caller', spawned_by_session_id: null, project_id: 'project-2' });
      expect(configOf(child.session_id)).not.toHaveProperty('parentRemote');
      expect(configOf(child.session_id).spawnedByRemote).toMatchObject({ deviceId: 'device-a', sessionId: 'remote-caller' });
      expect(await runRemoteSessionAction(remoteCaller, { action: 'children' })).toEqual([]);
      expect(await runSessionAction(context, { action: 'children' })).toEqual([expect.objectContaining({ session_id: child.session_id })]);
    });

    it('refuses a reserved child self-parent before creating a dormant remote work seat', async () => {
      project2Root();
      const childId = '10000000-0000-4000-8000-000000000005';
      const intent = { version: 1 as const, assistant_id: '10000000-0000-4000-8000-000000000001', work_id: '10000000-0000-4000-8000-000000000002', operation_id: '10000000-0000-4000-8000-000000000003', message_id: '10000000-0000-4000-8000-000000000004', child_session_id: childId, coordinator: { session_id: 'remote-caller', device_id: 'device-a' }, title: 'Task', continuation: false };
      await expect(runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x', parent_session_id: childId, assistant_work: intent }))
        .rejects.toThrow('a session cannot be its own parent');
      expect(childRows()).toEqual([]);
      expectNothingStarted();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    // owner 2026-10-30: project and parent are orthogonal — naming a project does not unhook the child from its spawner.
    it('spawns into a named project on this machine at its root — still under the caller unless the parent is null', async () => {
      project2Root();
      const result = (await runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x', project_id: 'project-2' })) as {
        session_id: string;
        parent_session_id: string | null;
      };
      expect(mocks.resolveProjectWorkspace).toHaveBeenCalledWith({ projectId: 'project-2', projectPath: '' });
      expect(result.parent_session_id).toBe('remote-caller');
      expect(configOf(result.session_id).parentRemote).toEqual({ deviceId: 'device-a', sessionId: 'remote-caller' });
      expect(childRows()[0]!.workspace_id).toBe('workspace-p2');
      const flat = (await runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x', project_id: 'project-2', parent_session_id: null })) as { session_id: string; parent_session_id: string | null };
      expect(flat.parent_session_id).toBeNull();
      expect(configOf(flat.session_id)).not.toHaveProperty('parentRemote');
      expect(configOf(flat.session_id).spawnedByRemote).toEqual(configOf(result.session_id).spawnedByRemote);
      expect(fixture.sqlite.prepare('SELECT project_id, workspace_id FROM sessions WHERE id = ?').get(flat.session_id))
        .toEqual({ project_id: 'project-2', workspace_id: 'workspace-p2' });
      expect(await runRemoteSessionAction(remoteCaller, { action: 'children' })).toEqual([
        expect.objectContaining({ session_id: result.session_id, parent_session_id: 'remote-caller', project_id: 'project-2' }),
      ]);
    });

    it('with no project lands in this machine\'s home project through the same step', async () => {
      project2Root();
      await runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x' });
      expect(mocks.resolveProjectWorkspace).toHaveBeenCalledWith({ projectId: undefined, projectPath: '' });
    });

    it('says which project this machine cannot open, before creating anything', async () => {
      await expect(runRemoteSessionAction(remoteCaller, { action: 'spawn', prompt: 'x', project_path: '~/nope' }))
        .rejects.toThrow('project ~/nope on this machine is not available');
      expect(childRows()).toEqual([]);
    });

    it('checks an inherited harness against what this machine offers', async () => {
      project2Root();
      await expect(runRemoteSessionAction({ ...remoteCaller, harness: 'no-such-harness' }, {
        action: 'spawn',
        prompt: 'x',
      })).rejects.toThrow("harness 'no-such-harness' (inherited from the calling session) is not offered on this machine");
      expect(childRows()).toEqual([]);
    });

    // #7199 发起方 agent 配的子 agent 默认 harness 随自述带来,这台机器同样先用它、没配才继承。
    it('spawns on the calling agent\'s default harness for sub-agents when harness is omitted', async () => {
      project2Root();
      const snapshot = (await runRemoteSessionAction({ ...remoteCaller, childHarness: 'claude' }, {
        action: 'spawn',
        prompt: 'x',
      })) as { session_id: string };
      const row = fixture.sqlite.prepare('SELECT provider FROM sessions WHERE id = ?').get(snapshot.session_id) as { provider: string };
      expect(row.provider).toBe('claude');
    });

    it('checks the calling agent\'s default harness against what this machine offers, and says where it came from', async () => {
      project2Root();
      await expect(runRemoteSessionAction({ ...remoteCaller, childHarness: 'no-such-harness' }, {
        action: 'spawn',
        prompt: 'x',
      })).rejects.toThrow("harness 'no-such-harness' (the calling agent's default for sub-agents) is not offered on this machine");
      expect(childRows()).toEqual([]);
    });

    it('re-checks an inherited Gugu model against this machine\'s catalog instead of falling back to BYOK', async () => {
      project2Root();
      await expect(runRemoteSessionAction({ ...remoteCaller, platformModel: 'platform:missing-model' }, {
        action: 'spawn',
        prompt: 'x',
      })).rejects.toThrow(/platform:missing-model/);
      expect(childRows()).toEqual([]);
    });

    it('answers locate with only the sessions that are on this machine', async () => {
      await expect(runRemoteSessionAction(remoteCaller, {
        action: 'locate',
        session_ids: ['caller', 'somewhere-else'],
      })).resolves.toEqual({ session_ids: ['caller'] });
    });

    it('delivers a message with the remote sender on the envelope', async () => {
      mocks.sendMessage.mockResolvedValue({ id: 'm1', status: 'delivered' });
      const result = (await runRemoteSessionAction(remoteCaller, {
        action: 'message',
        session_ids: ['caller'],
        text: 'the run finished',
      })) as { recipients: Array<{ to: string; status: string }> };
      expect(result.recipients).toEqual([expect.objectContaining({ to: 'session:caller', status: 'delivered' })]);
      const sent = mocks.sendMessage.mock.calls.at(-1)![0] as { sessionId: string; text: string; kind: string };
      expect(sent.sessionId).toBe('caller');
      expect(sent.kind).toBe('session-direct');
      expect(sent.text).toContain('from="Claude 7 · mac1"');
      expect(sent.text).toContain('from_id="session:remote-caller"');
    });

    it('reuses exact inbox identity and envelope bytes when a phone retries an acknowledged-or-unknown failure notice', async () => {
      // This assertion exercises the persisted timestamp, independent of the runner's timezone.
      vi.stubEnv('TZ', 'Asia/Shanghai');
      mocks.sendMessage.mockResolvedValue({ id: 'm1', status: 'delivered' });
      const action = { action: 'message' as const, session_ids: ['caller'], text: '这次手机任务没能完成，网络连接持续超时。',
        delivery_id: '022ebf62-18b2-4d78-987e-ddb02dd04c46', delivery_at: '2026-10-26T07:00:00.000Z' };
      await runRemoteSessionAction(remoteCaller, action);
      const first = mocks.sendMessage.mock.calls.at(-1)![0];
      await runRemoteSessionAction(remoteCaller, action);
      expect(mocks.sendMessage.mock.calls.at(-1)![0]).toEqual(first);
      expect(first.text).toContain(formatDeliveryTimestamp(action.delivery_at));
      await runRemoteSessionAction({ ...remoteCaller, sessionId: 'another-sender' }, action);
      expect(mocks.sendMessage.mock.calls.at(-1)![0].clientMessageId).not.toBe(first.clientMessageId);
      await expect(runRemoteSessionAction(remoteCaller, { ...action, delivery_at: undefined })).rejects.toThrow(/original timestamp/);
    });

    it('keeps the cloud message pending until native acceptance and formats its original time locally', async () => {
      const id = '8ff7b564-892b-4aa5-9d49-a85c1d5cb9ea';
      mocks.sendMessage.mockImplementation(async (params) => ({ id: params.clientMessageId, status: 'queued' }));
      const action = { action: 'message', session_ids: ['caller'], text: 'ready', client_message_id: id, client_message_at: '2026-10-26T01:00:00Z' } as const;
      const first = await runRemoteSessionAction(remoteCaller, action as never);
      const second = await runRemoteSessionAction(remoteCaller, action as never);
      expect(mocks.sendMessage.mock.calls.slice(-2).map(([params]) => params.clientMessageId)).toEqual([id, id]);
      expect(mocks.sendMessage.mock.calls.at(-1)![0].text).toContain(`at="${formatDeliveryTimestamp(action.client_message_at)}"`);
      expect(first).toEqual({ recipients: [expect.objectContaining({ to: 'session:caller', status: 'failed', message_id: id, error: {code:'SESSION_DIRECT_QUEUED',message:expect.any(String)} })] });
      expect(second).toEqual(first);
    });

    // owner 10-17:发信方自己说的发完以后去向与回的是哪条 —— 收件这台机器写上信封属性,正文不动;取值不对在投递前就拒。
    it('writes the sender\'s then / reply_to_message_id on the envelope, and refuses a then it does not know', async () => {
      mocks.sendMessage.mockResolvedValue({ id: 'm1', status: 'delivered' });
      await runRemoteSessionAction(remoteCaller, {
        action: 'message',
        session_ids: ['caller'],
        text: 'waiting on the build',
        then: 'wait',
        reply_to_message_id: 'msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f',
      });
      const sent = mocks.sendMessage.mock.calls.at(-1)![0] as { text: string };
      expect(sent.text.split('\n')[0]).toMatch(/ then="wait" in_reply_to="msg:6f1e2d3c-4b5a-4c6d-8e7f-0a1b2c3d4e5f">$/);
      expect(sent.text).toContain('<![CDATA[waiting on the build]]>');

      const calls = mocks.sendMessage.mock.calls.length;
      await expect(runRemoteSessionAction(remoteCaller, {
        action: 'message',
        session_ids: ['caller'],
        text: 'x',
        then: 'sleep',
      } as never)).rejects.toThrow(/then must be one of "continue", "wait", "stop"/);
      await expect(runRemoteSessionAction(remoteCaller, {
        action: 'message',
        session_ids: ['caller'],
        text: 'x',
        reply_to_message_id: 'asked',
      })).rejects.toThrow(/reply_to_message_id must be a msg:<uuid>/);
      await expect(runRemoteSessionAction(remoteCaller, {
        action: 'message',
        session_ids: ['caller'],
        text: 'x',
        reply_to_message_id: 'msg:the build failed, stop waiting',
      })).rejects.toThrow(/reply_to_message_id must be a msg:<uuid>/);
      expect(mocks.sendMessage.mock.calls.length).toBe(calls);
    });

    it('lists the children a remote caller spawned here, and only those', async () => {
      project2Root();
      const spawned = (await runRemoteSessionAction(remoteCaller, {
        action: 'spawn',
        prompt: 'x',
      })) as { session_id: string };
      await runSessionAction(context, { action: 'spawn', prompt: 'a local child' });
      const children = (await runRemoteSessionAction(remoteCaller, { action: 'children' })) as Array<{ session_id: string }>;
      expect(children.map((child) => child.session_id)).toEqual([spawned.session_id]);
    });

    it('needs session_id for get / stop / archive — the caller is not on this machine', async () => {
      await expect(runRemoteSessionAction(remoteCaller, { action: 'get' })).rejects.toThrow(/get needs session_id/);
      await expect(runRemoteSessionAction(remoteCaller, { action: 'get', session_id: 'caller' }))
        .resolves.toEqual(expect.objectContaining({ session_id: 'caller' }));
    });

    it('does not open tabs on another machine', async () => {
      await expect(runRemoteSessionAction(remoteCaller, { action: 'open_in_tab', url: 'https://example.com', intent: 'pinned' }))
        .rejects.toThrow(/own pane/);
    });
  });

  describe('stopExactSessionpageSession', () => {
    const exactTarget = {
      projectId: 'project-1',
      sessionId: 'caller',
    };

    // Retargeted: an ACP stop is now session-life's interrupt (default reason user-stop), never a direct runtime stop.
    it('stops the exact ACP conversation through session-life as a user stop', async () => {
      await expect(stopExactSessionpageSession(exactTarget)).resolves.toBe(true);
      expect(mocks.lifeInterrupt).toHaveBeenCalledExactlyOnceWith('caller', { k: 'interrupt', reason: 'user-stop' });
      expect(mocks.stopSession).not.toHaveBeenCalled();
      expect(mocks.settleSessionExited).toHaveBeenCalledWith({ sessionId: 'caller', projectId: 'project-1' });
    });

    it.each(['idle-reap', 'version-switch'] as const)('carries the %s reason to session-life unchanged', async (reason) => {
      await expect(stopExactSessionpageSession({ ...exactTarget, reason })).resolves.toBe(true);
      expect(mocks.lifeInterrupt).toHaveBeenCalledExactlyOnceWith('caller', { k: 'interrupt', reason });
      expect(mocks.stopSession).not.toHaveBeenCalled();
    });

    it('does not stop a same-id target whose project is stale', async () => {
      await expect(stopExactSessionpageSession({
        ...exactTarget,
        projectId: 'project-2',
      })).resolves.toBe(false);
    });

    it('surfaces an ACP stop failure unchanged', async () => {
      mocks.lifeInterrupt.mockRejectedValueOnce(new Error('ACP stop exploded'));
      await expect(stopExactSessionpageSession(exactTarget)).rejects.toThrow('ACP stop exploded');
    });

    it('stops the exact PTY conversation through its mount', async () => {
      fixture.sqlite
        .prepare(
          `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
           VALUES ('pty-exact', 'project-1', 'workspace-1', 'PTY exact', 'claude', 'pty')`
        )
        .run();
      mount('pty-exact');

      await expect(stopExactSessionpageSession({
        projectId: 'project-1',
        sessionId: 'pty-exact',
      })).resolves.toBe(true);
      expect(mocks.ptyStopSession).toHaveBeenCalledWith('pty-exact');
      expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
      // 挂载会广播 session:provisioned,渲染层据此把会话准备起来、把刚停的进程又拉起来(#4377)。
      expect(mocks.ensureSessionMounted).not.toHaveBeenCalled();
    });

    describe('a PTY session this host has not mounted (lazy reattach after an account-process restart)', () => {
      const cold = { projectId: 'project-1', sessionId: 'pty-cold' };
      const coldTmuxName = 'tmux:project-1:pty-cold:pty-cold';
      beforeEach(() => {
        fixture.sqlite
          .prepare(
            `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
             VALUES ('pty-cold', 'project-1', 'workspace-1', 'PTY cold', 'claude', 'pty')`
          )
          .run();
        mocks.openProjects = new Set(['project-1']);
        mocks.tmuxEnabled.mockImplementation(async () => true);
        mocks.tmuxSessionNames = new Set();
        mocks.listTmuxSessionNames.mockImplementation(async () => mocks.tmuxSessionNames);
        mocks.killTmuxSession.mockClear();
        mocks.listTmuxSessionNames.mockClear();
        mocks.settleSessionExited.mockClear();
      });
      afterEach(() => {
        mocks.openProjects = new Set();
      });

      it('kills its engine still running in tmux and settles it as exited — without mounting it', async () => {
        mocks.tmuxSessionNames = new Set(['tmux:other', coldTmuxName]);

        await expect(stopExactSessionpageSession(cold)).resolves.toBe(true);
        expect(mocks.killTmuxSession).toHaveBeenCalledExactlyOnceWith(expect.anything(), coldTmuxName);
        expect(mocks.settleSessionExited).toHaveBeenCalledWith({ sessionId: 'pty-cold', projectId: 'project-1' });
        // 挂载会广播 session:provisioned,渲染层据此把刚停的进程又拉起来(#4377)。
        expect(mocks.ensureSessionMounted).not.toHaveBeenCalled();
        expect(mocks.ptyStopSession).not.toHaveBeenCalled();
      });

      it('kills nothing when tmux has no session of that name: only the exact name is ever killed', async () => {
        mocks.tmuxSessionNames = new Set(['tmux:project-1:pty-cold-2:pty-cold-2']);

        await expect(stopExactSessionpageSession(cold)).resolves.toBe(true);
        expect(mocks.killTmuxSession).not.toHaveBeenCalled();
        expect(mocks.settleSessionExited).not.toHaveBeenCalled();
      });

      it('stops the tmux engine even when the task mount exists but has not reattached its process', async () => {
        mount(cold.sessionId);
        mocks.mounted.get(cold.sessionId)!.sessions.ownsSession = () => false;
        mocks.tmuxSessionNames.add(coldTmuxName);

        await expect(stopExactSessionpageSession(cold)).resolves.toBe(true);
        expect(mocks.killTmuxSession).toHaveBeenCalledExactlyOnceWith(expect.anything(), coldTmuxName);
        expect(mocks.ptyStopSession).not.toHaveBeenCalled();
        expect(mocks.ensureSessionMounted).not.toHaveBeenCalled();
      });

      it('stops the surviving engine even if the project now runs without tmux', async () => {
        mocks.tmuxEnabled.mockImplementation(async () => false);
        mocks.tmuxSessionNames.add(coldTmuxName);

        await expect(stopExactSessionpageSession(cold)).resolves.toBe(true);
        expect(mocks.killTmuxSession).toHaveBeenCalledExactlyOnceWith(expect.anything(), coldTmuxName);
        expect(mocks.ensureSessionMounted).not.toHaveBeenCalled();
      });

      it('stops a surviving engine without requiring its project to be opened first', async () => {
        mocks.openProjects = new Set();
        mocks.tmuxSessionNames.add(coldTmuxName);

        await expect(stopExactSessionpageSession(cold)).resolves.toBe(true);
        expect(mocks.killTmuxSession).toHaveBeenCalledExactlyOnceWith(expect.anything(), coldTmuxName);
      });
    });

  });
  it('fully default spawn is a session of its own in the caller workspace, nests under the caller, and starts through ACP', async () => {
    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Implement the parser.',
    })) as { session_id: string; parent_session_id: string | null };

    expect(result.parent_session_id).toBe('caller');
    // #4117: the spawner needs zero discovery steps — the result names the route back to the child.
    // #4191: atomic tool face — the route names the tool itself; no action field survives.
    // #4562: the unified union schema takes to:[typed address], so the route hands back exactly that.
    // #4566 阴性对照:本 case 的 caller 没有项目群(mocks.sessionpageProjectGroup = kind:'none'),点对点仍是
    // 唯一去处 —— 这半边必须不动,否则「无项目也硬指一个群」就是编造归属。
    expect((result as { message_route?: unknown }).message_route).toEqual({
      tool: 'session_message',
      to: [`session:${result.session_id}`],
    });
    expect(childRows()).toEqual([
      expect.objectContaining({
        id: result.session_id,
        parent_session_id: 'caller',
        spawned_by_session_id: 'caller',
      }),
    ]);
    // #5665 child 是一条独立会话,只共用 caller 的工作目录。
    expect(childRows()[0]!.workspace_id).toBe('workspace-1');
    // session-life starts it from the session row (workspace + unattended permission mode); nothing here starts the runtime.
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect((await getSessions()).find((session) => session.id === result.session_id)).toMatchObject({
      workspaceId: 'workspace-1',
      permissionMode: 'full-access',
    });
    // #6497 the default (codex) ACP child's delegation is its first pending row (one queue), not the legacy outbox.
    const [turn, ...rest] = admittedTurns(result.session_id);
    expect(rest).toEqual([]);
    expect(turn?.text).toContain('Implement the parser.');
    expect(mocks.lifeStart).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  // #6497 —— 每一家 ACP 都走这条,❌ 不再只有 claude。outbox 那条要等启动**完成之后**才投首条委托,
  // 而此刻打开的聊天面并进了同一次启动、恰好在这段空档里醒来:cell 读成「ready、空闲、没有首轮」,
  // 被 #4949 的空 cell 护栏判成「The engine could not start」(真 Electron、dev 构建实测 4/4,判死比首轮起跑早 37 ms)。
  // 首条委托在记录建出来那一刻就进 cell 的启动队列,这段空档就不存在。
  it.each(['claude', 'codex'])('routes a %s ACP child delegation through the ACP cell startup queue', async (harness) => {
    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Record this delegation in the child transcript.',
      harness,
      transport: 'acp',
    })) as { session_id: string };

    // Retargeted: the delegation is admitted into session-life's queue at creation (no start-carried initialQueue).
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(mocks.recordDeliveredSessionDirectMessage).toHaveBeenCalledWith(
      { sessionId: result.session_id },
      expect.objectContaining({ text: expect.stringContaining('Record this delegation in the child transcript.') }),
    );
    const recorded = mocks.recordDeliveredSessionDirectMessage.mock.calls.at(-1)![1] as { id: string; text: string };
    // Same id as the recorded transcript message; #6823 the envelope is the host's, so its origin says so.
    expect(admittedTurns(result.session_id)).toEqual([{
      sessionId: result.session_id, messageId: recorded.id, text: recorded.text, kind: 'ordinary',
      turn: { kind: 'prompt', origin: 'communication' },
    }]);
    expect(mocks.lifeStart).not.toHaveBeenCalled();
    // one channel only: the same delegation must not also sit in the outbox and be delivered twice
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  // #4566 —— owner 真机 0/4:四个 child 全部私发 parent,项目群里一条没有。回执里这一格正好落在
  // 「怎么跟新 child 说话」的决定点上,而且是机器可读的,提示词里那句「默认去项目群」跟它对着说时
  // 字段赢。所以判据读的是这一格:caller 有项目群 ⇒ 回执必须指向那个群。
  it('routes the spawn receipt to the project group when the caller has one', async () => {
    mocks.sessionpageProjectGroup = { kind: 'group', projectId: 'project-1', groupChatId: 'group-chat-1' };

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Implement the parser.',
    })) as { session_id: string };

    expect((result as { message_route?: unknown }).message_route).toEqual({
      tool: 'message_send',
      chat_id: 'group-chat-1',
      // 收件人必须在场。群里无寻址的发言唤不醒任何人(`agentInboxReader` 的广播分支要求发信人不是
      // agent),所以只给 chat_id 的路由是「发成功了、没人醒」—— 比原来那条点对点更糟(它至少响亮)。
      // 用 child 的 typed session 地址:它的 user id 要到自己 session start 才铸出来,而 spawn 不等那一步。
      to_user_ids: [`session:${result.session_id}`],
    });
    // 群必须是**caller 自己**那条会话的群。问错会话在这里长得一模一样——刚建出来的 child 还没有
    // 花名册记录,查它恒为「无群」,于是回执静悄悄退回点对点,正是本 bug 的形状。所以判据必须
    // 读到实参,❌ 不能只读返回值(不读实参时,把 context.conversationId 换成任何字面量都仍然全绿)。
    expect(mocks.sessionpageProjectGroupForSession).toHaveBeenCalledWith('caller', expect.anything());
  });

  it('spawns into a named project at its root — the task page new-task pick — still under the caller, point-to-point', async () => {
    project2Root();
    mocks.sessionpageProjectGroup = { kind: 'group', projectId: 'project-1', groupChatId: 'group-chat-1' };

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Look at the other repo.',
      project_path: '/other',
    })) as { session_id: string; parent_session_id: string | null; message_route?: unknown };

    expect(mocks.resolveProjectWorkspace).toHaveBeenCalledWith({ projectId: undefined, projectPath: '/other' });
    const [child] = childRows();
    expect(child).toEqual(expect.objectContaining({ id: result.session_id, parent_session_id: 'caller', spawned_by_session_id: 'caller' }));
    expect(child!.workspace_id).toBe('workspace-p2');
    expect(fixture.sqlite.prepare('SELECT project_id FROM sessions WHERE id = ?').get(result.session_id))
      .toEqual({ project_id: 'project-2' });
    expect(result.parent_session_id).toBe('caller');
    // child 入的是 project-2 的群,caller 不在里面:回执只给点对点。
    expect(result.message_route).toEqual({ tool: 'session_message', to: [`session:${result.session_id}`] });
  });

  it('delivers the OpenCode TUI first turn over router (serve/attach), not baked into argv', async () => {
    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Run the OpenCode first turn.',
      harness: 'opencode',
      transport: 'pty',
    })) as { session_id: string };

    // 升档为 serve/attach 后,attach 的 argv 是 `attach <url> --session <id>`,没有 prompt 槽:
    // opencode tui 的首轮不再烤进 spawn argv,而是与后续消息一样走 router 的 session-direct 投递。
    await vi.waitFor(() => expect(mocks.ptyStartSession).toHaveBeenCalledTimes(1));
    const [, , isResuming, initialPrompt] = mocks.ptyStartSession.mock.calls[0] ?? [];
    expect(isResuming).toBe(false);
    expect(initialPrompt).toBeUndefined();

    // 首轮经普通 outbox(session-direct)投递,不是 argv 快捷路径的 recordDelivered。
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      sessionId: result.session_id,
      kind: 'session-direct',
      text: expect.stringContaining('Run the OpenCode first turn.'),
    }));

    const row = fixture.sqlite
      .prepare('SELECT config FROM sessions WHERE id = ?')
      .get(result.session_id) as { config: string };
    const config = JSON.parse(row.config) as { initialPrompt?: string; firstUtterance?: string };
    // 首轮不烤进 argv ⇒ config 不持久化 initialPrompt;首句由 origin.firstUtterance 说出来。
    expect(config.initialPrompt).toBeUndefined();
    expect(config).toMatchObject({ firstUtterance: 'Run the OpenCode first turn.' });
  });

  it('uses an explicit harness and native model, clearing the caller platform decision', async () => {
    await recordSessionPlatformModel('caller', { modelId: 'gpt-5.6-luna' });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Use Claude for this task.',
      harness: 'claude',
      model: 'claude-sonnet-test',
    })) as { session_id: string };

    const row = fixture.sqlite
      .prepare('SELECT provider, config FROM sessions WHERE id = ?')
      .get(result.session_id) as { provider: string; config: string };
    expect(row.provider).toBe('claude');
    expect(JSON.parse(row.config)).toMatchObject({ model: 'claude-sonnet-test' });
    await expect(sessionPlatformModel(result.session_id)).resolves.toBeNull();
  });

  // #7199 「这个 agent 开子 agent 不指定 harness 时用哪个」是 agent 自己的显式配置:配了就用它,没配才继承调用方。
  describe('the calling agent\'s default harness for sub-agents', () => {
    beforeEach(() => {
      mocks.localAgentForSession.mockImplementation(async (sessionId: string) =>
        sessionId === 'caller' ? { gugu_user_id: 'agent-assistant' } : null);
    });

    it('omitting harness spawns on the configured default, and list_harnesses says so', async () => {
      await recordChildHarnessDefault('agent-assistant', 'claude');

      const result = (await runSessionAction(context, { action: 'spawn', prompt: 'Sort the inbox.' })) as { session_id: string };

      const row = fixture.sqlite.prepare('SELECT provider FROM sessions WHERE id = ?').get(result.session_id) as { provider: string };
      expect(row.provider).toBe('claude');
      await expect(runSessionAction(context, { action: 'list_harnesses' })).resolves.toMatchObject({
        current_harness: 'codex',
        spawn_default_harness: 'claude',
      });
    });

    it('a named harness still wins over the configured default', async () => {
      await recordChildHarnessDefault('agent-assistant', 'claude');

      const result = (await runSessionAction(context, {
        action: 'spawn',
        prompt: 'Use OpenCode.',
        harness: 'opencode',
      })) as { session_id: string };

      const row = fixture.sqlite.prepare('SELECT provider FROM sessions WHERE id = ?').get(result.session_id) as { provider: string };
      expect(row.provider).toBe('opencode');
    });

    it('nothing configured: inherits the caller harness and its model, as before', async () => {
      await recordSessionPlatformModel('caller', { modelId: 'gpt-5.6-luna' });

      const result = (await runSessionAction(context, { action: 'spawn', prompt: 'Sort the inbox.' })) as { session_id: string };

      const row = fixture.sqlite.prepare('SELECT provider FROM sessions WHERE id = ?').get(result.session_id) as { provider: string };
      expect(row.provider).toBe('codex');
      await expect(runSessionAction(context, { action: 'list_harnesses' })).resolves.toMatchObject({
        current_harness: 'codex',
        spawn_default_harness: 'codex',
      });
    });
  });

  // #7199 云电脑上跑 Pi 的助理点名 claude 派子 agent、不给模型:子会话从前落成 Claude 自家账号(那台机器没登录)。
  it('names a harness without a model: keeps the caller platform model when that harness offers it', async () => {
    await recordSessionPlatformModel('caller', { modelId: 'deepseek-v4-pro' });
    mocks.listLocalPlatformModels.mockResolvedValue({
      models: [{ id: 'platform:deepseek-v4-pro', name: 'DeepSeek V4 Pro', source: 'gugu' }],
      meta: { available: true, reason: null },
    });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Write the weekly report.',
      harness: 'claude',
    })) as { session_id: string };

    expect(mocks.listLocalPlatformModels).toHaveBeenCalledWith('claude', 'acp');
    await expect(sessionPlatformModel(result.session_id)).resolves.toEqual({ modelId: 'deepseek-v4-pro' });
  });

  it('names a harness without a model: that harness default when it does not offer the caller platform model', async () => {
    await recordSessionPlatformModel('caller', { modelId: 'deepseek-v4-pro' });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Write the weekly report.',
      harness: 'claude',
    })) as { session_id: string };

    await expect(sessionPlatformModel(result.session_id)).resolves.toBeNull();
  });

  it('names a harness without a model: does not carry a platform model that needs a membership there', async () => {
    await recordSessionPlatformModel('caller', { modelId: 'deepseek-v4-pro' });
    mocks.listLocalPlatformModels.mockResolvedValue({
      models: [{ id: 'platform:deepseek-v4-pro', name: 'DeepSeek V4 Pro', source: 'gugu', requires_membership: true }],
      meta: { available: true, reason: null },
    });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Write the weekly report.',
      harness: 'claude',
    })) as { session_id: string };

    await expect(sessionPlatformModel(result.session_id)).resolves.toBeNull();
  });

  it('keeps a harness model when its bare id is also in the Gugu catalog', async () => {
    const modelId = 'gpt-5.6-terra';
    mocks.listLocalPlatformModels.mockResolvedValueOnce({
      models: [{
        id: `platform:${modelId}`,
        name: 'GPT-5.6 Terra',
        source: 'gugu',
      }],
      meta: { available: true },
    });
    mocks.listLocalModels.mockResolvedValueOnce({
      models: [
        { id: modelId, name: 'GPT-5.6 Terra', source: 'harness' },
        { id: `platform:${modelId}`, name: 'GPT-5.6 Terra', source: 'gugu' },
      ],
    });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Use my Codex account.',
      model: modelId,
    })) as { session_id: string; model: { source: string; id: string | null } };

    expect(result.model).toEqual({
      source: 'harness',
      id: modelId,
      spawn_model_id: modelId,
    });
    await expect(sessionPlatformModel(result.session_id)).resolves.toBeNull();
  });

  it('refuses a harness the launch gate refuses before creating a child, with the gate\'s own words', async () => {
    const said = 'claude tui requires harness runtime 2.1.69 or newer; found 2.1.0. Update it, then retry.';
    mocks.assertLocalHarnessLaunchable.mockRejectedValueOnce(new Error(said));
    await expect(runSessionAction(context, {
      action: 'spawn',
      prompt: 'This should fail.',
      harness: 'claude',
      transport: 'pty',
    })).rejects.toThrow(said);
    expect(mocks.assertLocalHarnessLaunchable).toHaveBeenLastCalledWith('claude', 'pty');
    expect(childRows()).toEqual([]);
  });

  it('rejects an unknown harness before creating a child conversation', async () => {
    await expect(runSessionAction(context, {
      action: 'spawn',
      prompt: 'This should fail.',
      harness: 'does-not-exist',
    })).rejects.toThrow('Unknown agent provider: does-not-exist');
    expect(childRows()).toEqual([]);
  });

  // #4616 目录外的 `platform:` id 必须当场 fail loud、且**不落下会话行**。
  //
  // ⚠️ 这条**本来在 e2e 的第三回合**,而那里它是**不确定**的:它要求 agent 主动去发一个
  // 「明知会失败」的调用 —— CLEAN5/CLEAN6 它照做了,CLEAN7 它没做,判据于是超时红,
  // **红的是 agent 的顺从度,不是产品**。判据不该依赖 LLM 愿不愿意执行一条自毁指令。
  // ⇒ 挪到这一层:同一条产品行为,`runSessionAction` 直接调,确定性,还能顺带断言"没留下行"。
  it('rejects a platform model that is not in this harness+transport catalog, leaving no row', async () => {
    await expect(runSessionAction(context, {
      action: 'spawn',
      prompt: 'This model does not exist.',
      model: 'platform:definitely-not-a-real-gugu-model-4972',
    })).rejects.toThrow(/is not (in the Gugu model catalog|available) for .* on acp sessions/);
    // ❌ 拒绝必须发生在建行之前 —— 半条会话比一个干脆的拒绝更难查。
    expect(childRows()).toEqual([]);
  });

  // #7056 目录里有、但这个用户的会员档用不了:当场拒并说清,❌ 起一条签发那一步才失败的会话。
  it('rejects a platform model that needs a membership, leaving no row', async () => {
    mocks.listLocalPlatformModels.mockResolvedValueOnce({
      models: [{ id: 'platform:glm-5.3', requires_membership: true }],
      meta: { available: true, reason: null },
    });
    await expect(runSessionAction(context, {
      action: 'spawn',
      prompt: 'Members-only model.',
      model: 'platform:glm-5.3',
    })).rejects.toThrow(/needs a Gugu membership/);
    expect(childRows()).toEqual([]);
  });

  // 反面:不带前缀的同一个名字**不走**平台校验,它是 harness 自家模型的取值空间
  // (`default` / `opus[1m]` 那类别名),由 harness 在启动时判定。少了这条,上面那条可能
  // 只是"凡是查不到的 model 都拒",而不是"platform: 前缀这一支才查目录"。
  it('does not run a bare model id through the Gugu catalog check', async () => {
    const child = await runSessionAction(context, {
      action: 'spawn',
      prompt: 'A harness-native alias the catalog knows nothing about.',
      model: 'definitely-not-a-real-gugu-model-4972',
    }) as { model: { source: string; id: string | null } };
    expect(child.model).toEqual({
      source: 'harness',
      id: 'definitely-not-a-real-gugu-model-4972',
      spawn_model_id: 'definitely-not-a-real-gugu-model-4972',
    });
  });

  // #4366 一个平台会话把它的模型写在哪：**不在** `sessions.model`。composer 选了咕咕的模型时
  // 那一列故意留空（模型由网关签发的 token 钉死，见 build-create-session-params），唯一说明模型的是那条
  // per-session 平台记录。所以「照抄 caller.model」对平台会话抄到的正好是空值。
  const CALLER_PLATFORM_MODEL = 'gpt-5.6-luna';

  it('inherits the caller platform model, the only fact a platform session states its model with', async () => {
    await recordSessionPlatformModel('caller', { modelId: CALLER_PLATFORM_MODEL });

    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: '带上你的模型。',
    })) as { session_id: string };

    await expect(sessionPlatformModel(result.session_id)).resolves.toEqual({
      modelId: CALLER_PLATFORM_MODEL,
    });
  });

  // Retargeted: ACP spawn no longer writes the spawnStartupState gate; get projects starting from the runtime summary.
  it('projects starting through get while the provider startup is still pending', async () => {
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Keep the stable id while starting.',
    })) as { session_id: string; status: string };
    const { config } = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(child.session_id) as { config: string | null };
    expect(config ? JSON.parse(config) : {}).not.toHaveProperty('spawnStartupState');

    mocks.summaries = { [child.session_id]: { lifecycle: 'starting', isGenerating: false, queuedPromptCount: 0, pendingPermissionCount: 0, backgroundAgentCount: 0 } };
    await expect(runSessionAction(context, {
      action: 'get',
      session_id: child.session_id,
    })).resolves.toMatchObject({ session_id: child.session_id, status: 'starting' });

    // 起动之后,没有活摘要的 ACP 子会话报状态写入者写下的那一句:带着首句出生即 working。
    mocks.summaries = {};
    await vi.waitFor(async () => {
      await expect(runSessionAction(context, {
        action: 'get',
        session_id: child.session_id,
      })).resolves.toMatchObject({ session_id: child.session_id, status: 'working', detail: 'running' });
    });
  });

  // spec session-graph:`title` 是这个 child 的名字,不只是会话页那一行的标题 —— 显式给了就落在会话上,
  // 由 agent-provisioning 在 session start 当成它在通讯录里的显示名。这里守的是**显式这条事实**本身:
  // 标题的两种来源(显式 / 从首轮推出来)在 `sessions.title` 上已经同形,只有这一格分得开。
  it('records an explicit spawn title as the child agent name, and records nothing when it is derived', async () => {
    const named = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Implement the parser.',
      title: '小弟',
    })) as { session_id: string };
    const derived = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Implement the parser.',
    })) as { session_id: string };

    expect(namedRow(named.session_id)).toEqual({ title: '小弟', agentDisplayName: '小弟' });
    // 反例对照:没显式给名字时标题照旧从首轮推出来,而名字那一格必须是空的 —— 否则一整行提示词
    // 会被 provisioning 当成人名开户。
    expect(namedRow(derived.session_id)).toEqual({
      title: 'Implement the parser.',
      agentDisplayName: undefined,
    });
  });

  // #4280 —— 发信人展示名只认**显式**命名过的那个(spec session-graph:命名即寻址名)。
  // 对照就是那行退化标题:它在同一列里与「显式给的」同形,拿它当人名会直接骗到读信封的那个 agent
  // (真机实测撞过:`from` 变成了「Call the session_spawn tool exactly once…」)。
  it('shows the explicit sender name and never the title derived from the first prompt line', async () => {
    fixture.sqlite.prepare(
      `UPDATE sessions SET title = ?, config = ? WHERE id = 'caller'`,
    ).run(
      'Call the session_spawn tool exactly once with title …',
      JSON.stringify({ version: '1', type: 'acp', agentDisplayName: '分析甲' }),
    );
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'delegated work',
    })) as { session_id: string };
    const envelope = lastAcpDelegationEnvelope();
    expect(child.session_id).toBeTruthy();
    expect(envelope).toContain('from="分析甲"');
    expect(envelope).not.toContain('session_spawn tool exactly once');
  });

  // #6335 —— 身份一时查不到、也没显式命名时,发信人退回这一家的名字,❌ 不留空让收信方只剩 session:<uuid>。
  it('falls back to the agent family name when the sender has no identity name yet', async () => {
    await runSessionAction(context, { action: 'spawn', prompt: 'delegated work' });
    const envelope = lastAcpDelegationEnvelope();
    expect(envelope).toContain('from="Codex"');
  });

  it('returns live tab hygiene from the renderer acknowledgement for every target', async () => {
    const tabs = Array.from({ length: 5 }, (_, n) => ({ tab_id: `tab-${n}`, title: `Report ${n}`, kind: 'file', closable: true }));
    mocks.nextOpenFileResult = { success: true, tabs };
    mocks.installedExtensions = [{ manifest: { id: 'notes', contributes: { tabs: [{ name: 'board' }] } } }];
    for (const target of [{ path: 'data/report.csv' }, { url: 'https://example.com' }, { app_tab: 'notes.board' }]) {
      const result = await runSessionAction(context, { action: 'open_in_tab', ...target, intent: 'pinned' });
      expect(result).toMatchObject({ opened: true, tab_count: 5, tabs, note: expect.stringContaining('5 open tabs') });
    }
    mocks.nextOpenFileResult = { success: true, tabs: tabs.slice(0, 4) };
    const result = await runSessionAction(context, { action: 'open_in_tab', url: 'https://example.com', intent: 'preview' });
    expect(result).toMatchObject({ tab_count: 4 });
    expect(result).not.toHaveProperty('note');
  });

  it('lists and closes only the caller task and preserves a refused close', async () => {
    const tabs = [{ tab_id: 'chat', title: 'Conversation', kind: 'session', closable: false }];
    mocks.nextOpenFileResult = { success: true, tabs };
    await expect(runSessionAction(context, { action: 'list_tabs' })).resolves.toEqual({ tab_count: 1, tabs });
    mocks.nextOpenFileResult = { success: true, tabs, closed: false };
    await expect(runSessionAction(context, { action: 'close_tab', tab_id: 'file-1' })).resolves.toMatchObject({ closed: false, tabs });
    expect(mocks.emit).toHaveBeenLastCalledWith(expect.anything(), { requestId: expect.any(String), projectId: 'project-1', sessionId: 'caller', tabId: 'file-1' });
    mocks.nextOpenFileResult = { success: false, error: 'The conversation tab cannot be closed' };
    await expect(runSessionAction(context, { action: 'close_tab', tab_id: 'chat' })).rejects.toThrow('conversation tab');
    mocks.nextOpenFileResult = { success: true };
    await expect(runSessionAction(context, { action: 'list_tabs' })).rejects.toThrow('did not return live tabs');
  });

  it('opens whatever the browser pane can load in the owning task browser pane', async () => {
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      url: 'https://example.com/docs?q=1',
      intent: 'pinned',
    })).resolves.toEqual({
      opened: true,
      url: 'https://example.com/docs?q=1',
      intent: 'pinned',
    });

    expect(mocks.emit).toHaveBeenCalledWith(sessionOpenBrowserInPaneChannel, {
      requestId: expect.any(String),
      projectId: 'project-1',
      sessionId: 'caller',
      url: 'https://example.com/docs?q=1',
      intent: 'pinned',
    });
  });

  it('refuses what the pane cannot load, rather than a scheme list of its own', async () => {
    for (const url of ['gugu-ext://ext/page.html', 'javascript:alert(1)']) {
      await expect(runSessionAction(context, {
        action: 'open_in_tab',
        url,
        intent: 'preview',
      })).rejects.toThrow('unsupported-protocol');
    }
    // An agent names a target; it does not type into a search box.
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      url: 'some words that are not a url',
      intent: 'preview',
    })).rejects.toThrow('invalid-url');
  });

  it('reports which tab took the file instead of deciding it here', async () => {
    // 「用什么打开」住在 renderer 的解析层,人点和 agent 穿过同一个函数。宿主发的永远是
    // 同一个文件事件,再如实转述 renderer 报回来的结果 —— ❌ 不在这儿判一次。
    mocks.nextOpenFileResult = { success: true, openedWith: 'sheets.grid' };

    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'data/report.csv',
      intent: 'preview',
    })).resolves.toEqual({
      opened: true,
      path: '/repo/ws-1/data/report.csv',
      opened_with: 'sheets.grid',
      intent: 'preview',
    });

    // A file event, not an extension event: this side names no tab kind at all.
    expect(mocks.emit).toHaveBeenCalledWith(sessionOpenFileInPaneChannel, {
      requestId: expect.any(String),
      projectId: 'project-1',
      sessionId: 'caller',
      path: '/repo/ws-1/data/report.csv',
      external: false,
      intent: 'preview',
    });
  });

  it('omits opened_with when the built-in editor took the file', async () => {
    // The counter-example to the test above: same call shape, nothing claimed it, and
    // the result must not invent an opener.
    mocks.nextOpenFileResult = { success: true, openedWith: null };

    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'src/index.ts',
      intent: 'preview',
    })).resolves.toEqual({
      opened: true,
      path: '/repo/ws-1/src/index.ts',
      intent: 'preview',
    });
  });

  it('opens an installed extension tab, which installing alone never puts on screen', async () => {
    mocks.installedExtensions = [
      { manifest: { id: 'notes', contributes: { tabs: [{ name: 'board' }, { name: 'inbox' }] } } },
    ];

    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'notes.board',
      intent: 'pinned',
    })).resolves.toEqual({
      opened: true,
      app_tab: 'notes.board',
      intent: 'pinned',
    });

    expect(mocks.emit).toHaveBeenCalledWith(sessionOpenExtensionInPaneChannel, {
      requestId: expect.any(String),
      projectId: 'project-1',
      sessionId: 'caller',
      tabKind: 'notes.board',
      intent: 'pinned',
    });
  });

  it('refuses extension tabs that are unparseable, uninstalled, or not contributed', async () => {
    mocks.installedExtensions = [
      { manifest: { id: 'notes', contributes: { tabs: [{ name: 'board' }] } } },
    ];

    // Each of these would otherwise reach the pane as an unknown runtime kind and render
    // an unavailable tab — a tab that opened, so a reported success, showing nothing.
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'board',
      intent: 'preview',
    })).rejects.toThrow('app_tab must be');
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'ghost.board',
      intent: 'preview',
    })).rejects.toThrow('no installed App with id: ghost');
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'notes.missing',
      intent: 'preview',
    })).rejects.toThrow('contributes no tab named: missing');

  });

  // 摩擦单 F105: a tab that opens files has no tab of its own (F95). Opened bare it was a page with no file — its App's
  // «not opened for a file» on screen and in app_check — answered `opened: true` although the session closed it.
  it('refuses a tab that opens files, saying how to open the file instead, and opens nothing', async () => {
    mocks.installedExtensions = [
      {
        manifest: {
          id: 'store',
          contributes: { tabs: [{ name: 'main', opensFiles: { chat: ['.store.json'] } }, { name: 'todo', opensFiles: { session: ['TODO.md'] } }] },
        },
      },
    ];

    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'store.main',
      intent: 'pinned',
    })).rejects.toThrow("store.main opens files and has no tab of its own; open the file instead — a group's file: session_open_in_tab url=<its gugu-file:// link>");
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      app_tab: 'store.todo',
      intent: 'pinned',
    })).rejects.toThrow('a file of this session: session_open_in_tab path=<the file>');
    expect(mocks.emit).not.toHaveBeenCalledWith(sessionOpenExtensionInPaneChannel, expect.anything());
  });

  // 摩擦单 F122 (L10, F82): the agent asked to open TODO.md with its App — {path, app_tab} — and was refused
  // "requires exactly one of"; it got there on the third call. The pair is «open with X» now: X must claim the file.
  it('path with app_tab: opens the file with that App when it claims it, and says what it claims when not', async () => {
    mocks.installedExtensions = [
      { manifest: { id: 'kanban', contributes: { tabs: [{ name: 'board', opensFiles: { session: ['todo.md'] } }] } } },
    ];
    mocks.nextOpenFileResult = { success: true, openedWith: 'kanban.board' };
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'TODO.md',
      app_tab: 'kanban.board',
      intent: 'pinned',
    })).resolves.toEqual({ opened: true, path: '/repo/ws-1/TODO.md', opened_with: 'kanban.board', intent: 'pinned' });
    expect(mocks.emit).toHaveBeenCalledWith(sessionOpenFileInPaneChannel, expect.objectContaining({ path: '/repo/ws-1/TODO.md', tabKind: 'kanban.board' }));
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'notes.md',
      app_tab: 'kanban.board',
      intent: 'pinned',
    })).rejects.toThrow('kanban.board does not open this file: in a session it opens todo.md');
  });

  it('rejects missing files, directories, closed sessions, and unavailable workspaces before emitting', async () => {
    mocks.stat.mockResolvedValueOnce({
      success: false,
      error: { type: 'not-found', path: '/repo/ws-1/missing.ts', message: 'missing' },
    });
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'missing.ts',
      intent: 'preview',
    })).rejects.toThrow('missing');
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'directory',
      intent: 'preview',
    })).rejects.toThrow('path is not a file');

    fixture.sqlite.prepare("UPDATE sessions SET archived_at = datetime('now') WHERE id = 'caller'").run();
    await expect(runSessionAction(context, {
      action: 'open_in_tab',
      path: 'src/index.ts',
      intent: 'pinned',
    })).rejects.toThrow('current session is closed');
  });

  // Retargeted to PTY children: an ACP spawn no longer waits on any start (session-life owns it), so only the
  // terminal leg still has a start a sibling could queue behind.
  it('does not serialize siblings that share the current workspace', async () => {
    const firstStart = deferred<undefined>();
    mocks.ptyStartSession
      .mockImplementationOnce(() => firstStart.promise)
      .mockResolvedValueOnce(undefined);

    const firstSpawn = runSessionAction(context, {
      action: 'spawn',
      prompt: 'First sibling remains in start.',
      transport: 'pty',
    });
    await vi.waitFor(() => expect(mocks.ptyStartSession).toHaveBeenCalledTimes(1));

    const secondSpawn = runSessionAction(context, {
      action: 'spawn',
      prompt: 'Second sibling must not queue behind it.',
      transport: 'pty',
    });
    await expect(secondSpawn).resolves.toEqual(
      expect.objectContaining({ parent_session_id: 'caller' })
    );

    firstStart.resolve(undefined);
    await expect(firstSpawn).resolves.toEqual(
      expect.objectContaining({ parent_session_id: 'caller' })
    );
    expect(childRows()).toHaveLength(2);
  });

  it('admits ACP siblings without waiting on either start', async () => {
    const first = (await runSessionAction(context, { action: 'spawn', prompt: 'First ACP sibling.' })) as { session_id: string };
    const second = (await runSessionAction(context, { action: 'spawn', prompt: 'Second ACP sibling.' })) as { session_id: string };
    expect(admittedTurns(first.session_id)).toHaveLength(1);
    expect(admittedTurns(second.session_id)).toHaveLength(1);
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(childRows()).toHaveLength(2);
  });

  // owner 2026-10-30: project and parent are orthogonal — naming another project still nests by default; only parent_session_id:null
  // leaves the child at its project's root.
  it('nests under the caller by default even in another project; parent_session_id:null leaves it a root session there', async () => {
    project2Root();
    const otherProject = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Work in the other repo for me.',
      project_path: '/other',
    })) as { session_id: string; parent_session_id: string | null };
    expect(otherProject.parent_session_id).toBe('caller');
    expect(fixture.sqlite.prepare('SELECT project_id, parent_session_id, spawned_by_session_id FROM sessions WHERE id = ?').get(otherProject.session_id))
      .toEqual({ project_id: 'project-2', parent_session_id: 'caller', spawned_by_session_id: 'caller' });
    const flat = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'A session of your own in the other repo.',
      project_path: '/other',
      parent_session_id: null,
    })) as { session_id: string; parent_session_id: string | null };
    expect(flat.parent_session_id).toBeNull();
    expect(fixture.sqlite.prepare('SELECT project_id, parent_session_id, spawned_by_session_id FROM sessions WHERE id = ?').get(flat.session_id))
      .toEqual({ project_id: 'project-2', parent_session_id: null, spawned_by_session_id: 'caller' });
    expect(await runSessionAction(context, { action: 'children' })).toEqual([
      expect.objectContaining({ session_id: otherProject.session_id, parent_session_id: 'caller', project_id: 'project-2' }),
    ]);
  });

  function makePtyCaller() {
    fixture.sqlite.prepare('UPDATE sessions SET runtime = ? WHERE id = ?').run('pty', 'caller');
  }

  it('chooses a local parent independently of the spawner and project before starting', async () => {
    project2Root();
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, title, runtime) VALUES ('chosen-parent', 'project-1', 'Parent', 'acp')").run();
    const child = await runSessionAction(context, {
      action: 'spawn', prompt: 'Work elsewhere.', project_id: 'project-2', parent_session_id: 'chosen-parent',
    }) as { session_id: string; parent_session_id: string | null };
    expect(child.parent_session_id).toBe('chosen-parent');
    expect(fixture.sqlite.prepare('SELECT project_id, parent_session_id, spawned_by_session_id FROM sessions WHERE id = ?').get(child.session_id))
      .toEqual({ project_id: 'project-2', parent_session_id: 'chosen-parent', spawned_by_session_id: 'caller' });
    expect(await runSessionAction(context, { action: 'children', session_id: 'chosen-parent' }))
      .toEqual([expect.objectContaining({ session_id: child.session_id })]);
    expect(await runSessionAction(context, { action: 'children' })).toEqual([]);
  });

  it('rejects an unavailable parent before creating or starting a child', async () => {
    await expect(runSessionAction(context, { action: 'spawn', prompt: 'x', parent_session_id: 'not-owned-or-missing' }))
      .rejects.toThrow('parent session not found on any of your machines');
    expect(childRows()).toEqual([]);
    expectNothingStarted();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])('stores a chosen parent on a third machine and preserves the spawner (remote caller: %s)', async (remoteCaller) => {
    project2Root();
    setOtherMachines({
      devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(),
      sessions: async () => ({
        sessions: [{ deviceId: 'device-c', label: 'Third computer', session: { conversationId: 'chosen-remote', projectId: 'remote-project', parentConversationId: 'unreachable-ancestor' } as SessionpageSessionSummary, listsAgents: true }],
        unreached: [{ deviceId: 'device-d', label: 'Offline computer', detail: 'no answer' }],
      }),
      archive: vi.fn(), appMessage: vi.fn(), appReadFile: vi.fn(), appCall: vi.fn(),
    });
    const action = { action: 'spawn' as const, prompt: 'x', project_id: 'project-2', parent_session_id: 'chosen-remote' };
    const child = await (remoteCaller
      ? runRemoteSessionAction({ deviceId: 'device-a', deviceLabel: null, sessionId: 'remote-spawner', agentUserId: null, name: null, harness: 'codex', transport: 'acp', model: null, platformModel: null }, action)
      : runSessionAction(context, action)) as { session_id: string; parent_session_id: string; not_reached: string[]; spawned_by_session_id: string };
    expect(child).toMatchObject({ parent_session_id: 'chosen-remote', not_reached: ['Offline computer'], spawned_by_session_id: remoteCaller ? 'remote-spawner' : 'caller' });
    const row = fixture.sqlite.prepare('SELECT parent_session_id, spawned_by_session_id, config FROM sessions WHERE id = ?').get(child.session_id) as { parent_session_id: string | null; spawned_by_session_id: string | null; config: string };
    expect(row.parent_session_id).toBeNull();
    expect(row.spawned_by_session_id).toBe(remoteCaller ? null : 'caller');
    const config = JSON.parse(row.config);
    expect(config.parentRemote).toEqual({ deviceId: 'device-c', sessionId: 'chosen-remote' });
    if (remoteCaller) expect(config.spawnedByRemote).toMatchObject({ deviceId: 'device-a', sessionId: 'remote-spawner' });
    else expect(config).not.toHaveProperty('spawnedByRemote');
    expect(await runSessionAction(context, { action: 'children', session_id: 'chosen-remote' }))
      .toEqual([expect.objectContaining({ session_id: child.session_id })]);
    expect(await runSessionAction(context, { action: 'children' })).toEqual([]);
  });

  function transportOfRow(sessionId: string): string | null {
    const row = fixture.sqlite
      .prepare('SELECT runtime FROM sessions WHERE id = ?')
      .get(sessionId) as { runtime: string | null } | undefined;
    return row?.runtime ?? null;
  }

  it('spawns the requested shape from either side when transport is explicit', async () => {
    makePtyCaller();
    const panelChild = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Panel please.',
      transport: 'acp',
    })) as { session_id: string; transport: string };

    expect(panelChild.transport).toBe('acp');
    expect(transportOfRow(panelChild.session_id)).toBe('acp');
    expect(admittedTurns(panelChild.session_id)).toHaveLength(1);
    expect(mocks.ptyStartSession).not.toHaveBeenCalled();

    fixture.sqlite.prepare('UPDATE sessions SET runtime = ? WHERE id = ?').run('acp', 'caller');
    const terminalChild = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Terminal please.',
      transport: 'pty',
    })) as { session_id: string; transport: string };

    expect(terminalChild.transport).toBe('pty');
    expect(transportOfRow(terminalChild.session_id)).toBe('pty');
    await vi.waitFor(() => expect(mocks.ptyStartSession).toHaveBeenCalledTimes(1));
    expect(admittedTurns(terminalChild.session_id)).toEqual([]);
  });

  it('reads a pty child status from its agent-hook row and stops it through its mount', async () => {
    insertPtyChild('pty-child', 'working', 'caller');
    // An ACP summary carrying the same id must not be able to speak for a pty session — that is the
    // whole point of routing status by transport rather than by whatever signal happens to be present.
    mocks.summaries = {
      'pty-child': {
        lifecycle: 'ready',
        isGenerating: false,
        queuedPromptCount: 0,
        pendingPermissionCount: 0,
        backgroundAgentCount: 0,
      },
    };

    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(
      expect.objectContaining({ transport: 'pty', status: 'working', runtime: null })
    );

    fixture.sqlite
      .prepare('UPDATE sessions SET agent_status = ? WHERE id = ?')
      .run('needs_user', 'pty-child');
    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'needs_user' }));

    await runSessionAction(context, { action: 'stop', session_id: 'pty-child' });
    expect(mocks.ptyStopSession).toHaveBeenCalledWith('pty-child');
  });

  // #6095 —— stop 之后进程已经没了,而 `session_stop` / `session_children` / `session_get` 三个读数
  // 连续 4 分钟都还是 `working`:pty 的回合状态全靠 harness 打回的 hook 边沿,而**被杀掉的进程打不出
  // 任何边沿**,那一列就永远停在最后一次 start 上。编排方因此只能退回去查操作系统进程表。
  // #6546 —— 停掉的会话照样收得进 session_message,所以读数是「被打断、空闲」(ready),不是 closed。
  it('reports a stopped pty child from the interrupt its stop wrote, on every reader', async () => {
    insertPtyChild('pty-child', 'working', 'caller');
    // 起点就是票里那一格:最后一条边沿是 start ⇒ 这一行停在 working。
    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ transport: 'pty', status: 'working' }));

    // transport 那一步把「被打断」交给写入者 —— 顺序就是判据:stop 的回执必须是这一步**之后**读的行,
    // 读了旧快照就还是 working。
    mocks.ptyStopSession.mockImplementation(async (id: string) => {
      markInterrupted(id);
    });

    await expect(
      runSessionAction(context, { action: 'stop', session_id: 'pty-child' })
    ).resolves.toEqual(
      expect.objectContaining({ session_id: 'pty-child', transport: 'pty', status: 'idle', detail: 'plain' })
    );
    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'idle' }));
    await expect(runSessionAction(context, { action: 'children' })).resolves.toEqual([
      expect.objectContaining({ session_id: 'pty-child', status: 'idle' }),
    ]);
  });

  // 阳控:同一个读法,只是没有 stop —— 必须仍然照 agent_status 报。
  it('keeps reporting a live pty child from its agent-hook row when no stop was recorded', async () => {
    insertPtyChild('pty-child', 'working', 'caller');
    fixture.sqlite
      .prepare('UPDATE sessions SET config = ? WHERE id = ?')
      .run(JSON.stringify({ version: '1', type: 'pty' }), 'pty-child');

    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'working' }));
  });

  // 被拒停住的 child 在状态上与做完的一模一样(idle):session_get 上的 preview.ended 把两者分开。
  // 宿主的 children 不算近况(#7379 复核):工具层切完窗以后才对窗内的行逐个走 get。
  it('session_get carries how the last turn ended; children reads no preview; an unreadable record is said on its row', async () => {
    insertPtyChild('refused', 'idle', 'caller');
    insertPtyChild('unreadable', 'idle', 'caller');
    const original = mocks.readSessionPreview.getMockImplementation();
    mocks.readSessionPreview.mockClear();
    mocks.readSessionPreview.mockImplementation(async (sessionId: string) =>
      sessionId === 'unreadable'
        ? { ok: false, error: { code: 'record_not_found', message: '找不到 claude 会话记录' } }
        : {
            ok: true,
            value: {
              running: false,
              now: null,
              ended: { kind: 'done', reason: 'refusal' },
              entries: [{ kind: 'text', id: `${sessionId}-a1`, text: '写到一半', truncated: false, at: null }],
            },
          });
    try {
      const children = (await runSessionAction(context, { action: 'children' })) as Array<Record<string, unknown>>;
      expect(children.map((child) => child.session_id).sort()).toEqual(['refused', 'unreadable']);
      expect(children.every((child) => !('preview' in child))).toBe(true);
      expect(mocks.readSessionPreview).not.toHaveBeenCalled();

      await expect(runSessionAction(context, { action: 'get', session_id: 'refused' })).resolves.toEqual(
        expect.objectContaining({
          status: 'idle',
          preview: {
            running: false,
            now: null,
            ended: { kind: 'done', reason: 'refusal' },
            // 给界面对位用的 id 不出给 agent。
            entries: [{ kind: 'text', text: '写到一半', truncated: false, at: null }],
          },
        }),
      );
      await expect(runSessionAction(context, { action: 'get', session_id: 'unreadable' })).resolves.toEqual(
        expect.objectContaining({ preview: { error: { code: 'record_not_found', message: '找不到 claude 会话记录' } } }),
      );
      expect(mocks.readSessionPreview).toHaveBeenCalledTimes(2);
    } finally {
      mocks.readSessionPreview.mockImplementation(original!);
    }
  });

  // 停在启动途中的那一格:`spawnStartupState` 还挂着 starting,而传输已经没了。
  // 报 starting 会让编排方以为再等等就好了 ⇒ stop 连同起动门一起关上。
  it('closes the startup gate when a spawning pty child is stopped mid-startup', async () => {
    insertPtyChild('pty-child', 'working', 'caller');
    fixture.sqlite
      .prepare('UPDATE sessions SET config = ? WHERE id = ?')
      .run(JSON.stringify({ version: '1', type: 'pty', spawnStartupState: 'starting' }), 'pty-child');
    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'starting' }));

    mocks.ptyStopSession.mockImplementation(async (id: string) => {
      markInterrupted(id);
    });
    await expect(
      runSessionAction(context, { action: 'stop', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'idle' }));
    await expect(
      runSessionAction(context, { action: 'get', session_id: 'pty-child' })
    ).resolves.toEqual(expect.objectContaining({ status: 'idle' }));
  });

  // 同一条规则的 ACP 面:它有一份真的 live summary,所以 stop 的回执要读**那一份**。
  // 此前这里传的是 `{}` —— 一个「我没读」冒充的读数,于是回执恒为 unknown,而一毫秒后的
  // `session_get` 对同一条会话给出另一个答案。
  it('answers stop on an acp child from the live summary, not from an empty one', async () => {
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Panel child.',
      transport: 'acp',
    })) as { session_id: string };
    expect(admittedTurns(child.session_id)).toHaveLength(1);

    mocks.summaries = {
      [child.session_id]: {
        lifecycle: 'closed',
        isGenerating: false,
        queuedPromptCount: 0,
        pendingPermissionCount: 0,
        backgroundAgentCount: 0,
      },
    };

    // 写入者落下的「被打断」(真实产品里 settleSessionExited 写 idle/plain)。
    mocks.settleSessionExited.mockImplementationOnce(async ({ sessionId }) => markInterrupted(sessionId));
    const receipt = await runSessionAction(context, { action: 'stop', session_id: child.session_id });
    expect(mocks.settleSessionExited).toHaveBeenCalledWith(expect.objectContaining({ sessionId: child.session_id }));
    // 回执读的是停这一端落定之后的行,❌ 等状态桥下一次推送(那之前会读到旧的 working)。
    expect(receipt).toEqual(expect.objectContaining({
      transport: 'acp',
      status: 'idle',
      detail: 'plain',
      runtime: expect.objectContaining({ lifecycle: 'closed' }),
    }));
    // 回执与随后的 get 对同一条会话给同一个答案;「运行时没了」不是一种状态(#6546)。
    const after = await runSessionAction(context, { action: 'get', session_id: child.session_id });
    expect((receipt as { status: string }).status).toBe((after as { status: string }).status);
    expect((receipt as { status: string }).status).not.toBe('closed');
  });

  // Retargeted: an ACP startup failure is the session's own failed state in session-life, so spawn hands the start
  // over and returns; nothing here waits on it or archives the child for it.
  it('returns the child immediately and never archives it for its ACP start', async () => {
    const result = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Will fail to start.',
    })) as { session_id: string; status: string };
    expect(admittedTurns(result.session_id)).toHaveLength(1);
    expect(mocks.startSession).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(fixture.sqlite.prepare('SELECT archived_at FROM sessions WHERE id = ?').get(result.session_id)).toEqual({ archived_at: null });
    expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
  });

  it('archives the child for Restore when cancellation lands after creation but before ACP start', async () => {
    const controller = new AbortController();
    mocks.emit.mockImplementationOnce(() => controller.abort(new Error('grant revoked')));
    const spawning = runSessionAction(context, { action: 'spawn', prompt: 'Orphan.' }, controller.signal);
    await expect(spawning).rejects.toThrow('grant revoked');
    const children = childRows();
    expect(children).toHaveLength(1);
    expectNothingStarted();
    await expectFailedChildToRestore(children[0]!.id);
  });

  it('does not cancel provider startup after the spawn response is returned', async () => {
    const controller = new AbortController();
    const spawning = await runSessionAction(context, { action: 'spawn', prompt: 'Compensate.' }, controller.signal);
    controller.abort(new Error('request ended after spawn'));
    // The start was handed to session-life before the response; the abort neither interrupts nor archives it.
    expect(admittedTurns((spawning as { session_id: string }).session_id)).toHaveLength(1);
    await Promise.resolve();
    expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
    expect(childRows()).toHaveLength(1);
    expect(fixture.sqlite.prepare('SELECT archived_at FROM sessions WHERE id = ?').get((spawning as { session_id: string }).session_id)).toEqual({ archived_at: null });
  });

  it('reaches a child in another project and a session it did not spawn alike, but never stops itself', async () => {
    project2Root();
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Work in the other repo.',
      project_id: 'project-2',
    })) as { session_id: string };
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
         VALUES ('unrelated', 'project-1', 'workspace-1', 'Unrelated', 'codex', 'acp')`
      )
      .run();

    await expect(
      runSessionAction(context, { action: 'get', session_id: child.session_id })
    ).resolves.toEqual(
      expect.objectContaining({ session_id: child.session_id, project_id: 'project-2' })
    );
    await expect(
      runSessionAction(context, { action: 'stop', session_id: child.session_id })
    ).resolves.toEqual(expect.objectContaining({ session_id: child.session_id }));
    expect(mocks.lifeInterrupt).toHaveBeenCalledWith(child.session_id, { k: 'interrupt', reason: 'user-stop' });

    await expect(
      runSessionAction(context, { action: 'get', session_id: 'unrelated' })
    ).resolves.toEqual(expect.objectContaining({ session_id: 'unrelated', spawned_by_session_id: null }));
    await expect(
      runSessionAction(context, { action: 'stop', session_id: 'unrelated' })
    ).resolves.toEqual(expect.objectContaining({ session_id: 'unrelated' }));
    expect(mocks.lifeInterrupt).toHaveBeenCalledWith('unrelated', { k: 'interrupt', reason: 'user-stop' });
    expect(mocks.stopSession).not.toHaveBeenCalled();

    mocks.lifeInterrupt.mockClear();
    await expect(
      runSessionAction(context, { action: 'stop', session_id: context.sessionId })
    ).rejects.toThrow('a session cannot stop itself');
    expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
  });

  const liveSummary = (sessionId: string, overrides: Record<string, unknown> = {}) => ({
    sessionId: sessionId,
    projectId: 'project-1',
    providerId: 'codex',
    lifecycle: 'working',
    isGenerating: true,
    lastStopReason: null,
    pendingPermissionCount: 0,
    backgroundAgentCount: 0,
    queuedPromptCount: 0,
    title: 'Child',
    updatedAt: 1,
    ...overrides,
  });
  const writeStatus = (sessionId: string, status: string, detail: string | null = null) =>
    fixture.sqlite
      .prepare('UPDATE sessions SET agent_status = ?, agent_status_detail = ? WHERE id = ?')
      .run(status, detail, sessionId);

  it('reports the same written status and live summary through children and get', async () => {
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Ask for permission.',
    })) as { session_id: string };
    const summary = liveSummary(child.session_id, { pendingPermissionCount: 1 });
    mocks.summaries[child.session_id] = summary;
    writeStatus(child.session_id, 'needs_user', 'approval');

    const [fromChildren] = (await runSessionAction(context, {
      action: 'children',
    })) as Array<{ status: string; runtime: unknown }>;
    const fromGet = (await runSessionAction(context, {
      action: 'get',
      session_id: child.session_id,
    })) as { status: string; runtime: unknown };

    for (const reading of [fromChildren, fromGet]) {
      expect(reading).toEqual(expect.objectContaining({ status: 'needs_user', detail: 'approval', runtime: summary }));
    }
  });

  it('an ACP child without a live summary reports what the status writer wrote', async () => {
    const child = (await runSessionAction(context, {
      action: 'spawn',
      prompt: 'Disappear from the runtime.',
    })) as { session_id: string };
    writeStatus(child.session_id, 'working', 'running');

    await expect(
      runSessionAction(context, { action: 'get', session_id: child.session_id }),
    ).resolves.toEqual(expect.objectContaining({ status: 'working', runtime: null }));
  });

// spec session-graph「父会话是调用方的主动选择」+ session_set_parent(owner 2026-10-02): the parent edge can be changed at any
// time, by the same encoding spawn writes it with; who spawned a session stays as it was.
describe('session_set_parent', () => {
  const context: SessionCallerContext = {
    sessionId: 'caller',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  };

  function seed(id: string, parent: string | null, spawnedBy: string | null = null, config: unknown = null) {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime, parent_session_id, spawned_by_session_id, config)
         VALUES (?, 'project-1', 'workspace-1', ?, 'codex', 'acp', ?, ?, ?)`
      )
      .run(id, `Session ${id}`, parent, spawnedBy, config === null ? null : JSON.stringify(config));
  }

  function edges(id: string) {
    const row = fixture.sqlite
      .prepare('SELECT parent_session_id, spawned_by_session_id, config FROM sessions WHERE id = ?')
      .get(id) as { parent_session_id: string | null; spawned_by_session_id: string | null; config: string | null };
    return { parent: row.parent_session_id, spawnedBy: row.spawned_by_session_id, config: row.config ? JSON.parse(row.config) : null };
  }

  afterEach(() => setOtherMachines(null));

  const childIds = async (id: string) =>
    ((await runSessionAction(context, { action: 'children', session_id: id })) as Array<{ session_id: string }>)
      .map((row) => row.session_id);

  // owner 2026-10-08:session_children 与侧栏同一个关系 —— 挂在谁下面;派出去没挂的不是子会话,谁派的只是来历。
  it('lists children by the parent edge: a moved session follows its new parent, an unnested one is nobody\'s child', async () => {
    seed('someone-else', null);
    seed('moved', 'someone-else', 'someone-else');
    seed('standalone', null, 'caller');
    expect(await childIds('someone-else')).toEqual(['moved']);
    expect(await childIds('caller')).toEqual([]);

    await runSessionAction(context, { action: 'set_parent', session_id: 'moved', parent_session_id: 'caller' });

    expect(await childIds('caller')).toEqual(['moved']);
    expect(await childIds('someone-else')).toEqual([]);
    await expect(runSessionAction(context, { action: 'get', session_id: 'moved' }))
      .resolves.toEqual(expect.objectContaining({ parent_session_id: 'caller', spawned_by_session_id: 'someone-else' }));
  });

  it('lists a child that hangs under a session on another machine (config parentRemote) as that session\'s child', async () => {
    seed('visitor', null, null, { version: '1', type: 'acp', parentRemote: { deviceId: 'dev-far', sessionId: 'far-parent' } });
    seed('passer-by', null, null, { version: '1', type: 'acp', spawnedByRemote: { deviceId: 'dev-far', sessionId: 'far-parent' } });
    expect(await childIds('far-parent')).toEqual(['visitor']);
  });

  it('puts a session under another one and back out as a root; who spawned it stays, the list hears the change', async () => {
    seed('someone-else', null);
    seed('loose', null, 'someone-else');
    mocks.emit.mockClear();

    await expect(runSessionAction(context, { action: 'set_parent', session_id: 'loose', parent_session_id: 'caller' }))
      .resolves.toEqual({ session_id: 'loose', parent_session_id: 'caller' });
    expect(edges('loose')).toEqual(expect.objectContaining({ parent: 'caller', spawnedBy: 'someone-else' }));
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, expect.objectContaining({
      sessionId: 'loose', changes: { parentSessionId: 'caller' },
    }));
    await expect(runSessionAction(context, { action: 'get', session_id: 'loose' }))
      .resolves.toEqual(expect.objectContaining({ parent_session_id: 'caller' }));

    await runSessionAction(context, { action: 'set_parent', session_id: 'loose', parent_session_id: null });
    expect(edges('loose')).toEqual(expect.objectContaining({ parent: null, spawnedBy: 'someone-else' }));
  });

  it('lets a session move itself, unlike stop and archive', async () => {
    seed('other', null);
    await runSessionAction(context, { action: 'set_parent', session_id: 'caller', parent_session_id: 'other' });
    expect(edges('caller').parent).toBe('other');
  });

  it('refuses a cycle and a parent that is nowhere, before writing anything', async () => {
    seed('a', 'caller');
    seed('b', 'a');
    await expect(runSessionAction(context, { action: 'set_parent', session_id: 'caller', parent_session_id: 'b' }))
      .rejects.toThrow('that makes a cycle: session:b is under session:caller');
    await expect(runSessionAction(context, { action: 'set_parent', session_id: 'a', parent_session_id: 'a' }))
      .rejects.toThrow('a session cannot be its own parent');
    await expect(runSessionAction(context, { action: 'set_parent', session_id: 'a', parent_session_id: 'ghost' }))
      .rejects.toThrow('parent session not found on any of your machines');
    expect(edges('caller').parent).toBeNull();
    expect(edges('a').parent).toBe('caller');
  });

  it('records a parent on another machine in config, and drops the older nested mark so it is read only once', async () => {
    seed('visitor', null, null, { version: '1', type: 'acp', spawnedByRemote: { deviceId: 'dev-old', sessionId: 'old-parent', nested: true } });
    setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(),
      sessions: async () => ({
        sessions: [{ deviceId: 'dev-far', label: 'far box', session: { conversationId: 'far', projectId: 'p-far', parentConversationId: null } as SessionpageSessionSummary, listsAgents: true }],
        unreached: [],
      }),
      archive: async () => undefined,
      appMessage: async () => ({ id: 'unused' }),
      appReadFile: async () => { throw new Error('no file is read in this test'); },
      appCall: async () => { throw new Error('no App call is made in this test'); },
    });

    await runSessionAction(context, { action: 'set_parent', session_id: 'visitor', parent_session_id: 'far' });
    const after = edges('visitor');
    expect(after.parent).toBeNull();
    expect(after.config.parentRemote).toEqual({ deviceId: 'dev-far', sessionId: 'far' });
    expect(after.config.spawnedByRemote).toEqual({ deviceId: 'dev-old', sessionId: 'old-parent' });
    await expect(runSessionAction(context, { action: 'get', session_id: 'visitor' }))
      .resolves.toEqual(expect.objectContaining({ parent_session_id: 'far' }));

    await runSessionAction(context, { action: 'set_parent', session_id: 'visitor', parent_session_id: null });
    expect(edges('visitor').config.parentRemote).toBeUndefined();
    await expect(runSessionAction(context, { action: 'get', session_id: 'visitor' }))
      .resolves.toEqual(expect.objectContaining({ parent_session_id: null }));
  });
});

// spec session-graph「agent 收起会话只有归档」(#6720): the SAME archive a person performs from the session page,
// reachable by an agent for any other session in its project, whoever spawned it.
describe('session_archive', () => {
  const context: SessionCallerContext = {
    sessionId: 'caller',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
  };

  function seedChild(id: string, spawnedBy = 'caller') {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime, parent_session_id, spawned_by_session_id)
         VALUES (?, 'project-1', 'workspace-1', ?, 'claude', 'acp', ?, ?)`
      )
      .run(id, `Child ${id}`, spawnedBy, spawnedBy);
  }

  function archivedAt(id: string): string | null {
    const row = fixture.sqlite.prepare('SELECT archived_at FROM sessions WHERE id = ?').get(id) as
      | { archived_at: string | null }
      | undefined;
    if (!row) throw new Error(`session ${id} is gone — archive must never remove the row`);
    return row.archived_at;
  }

  it('archives a managed child through archiveSession: runtime stopped, row kept and stamped, its own child untouched', async () => {
    seedChild('child-a');
    seedChild('grandchild', 'child-a');

    await expect(runSessionAction(context, { action: 'archive', session_id: 'child-a' })).resolves.toEqual({
      session_id: 'child-a',
      archived: true,
      with_children: false,
      children_archived: 0,
    });
    // Runtime stopped = session-life archived it (ACP archive no longer stops the runtime client directly).
    expect(interruptedFor('archive')).toEqual(['child-a']);
    expect(mocks.stopSession).not.toHaveBeenCalled();
    // The row stays, so a person can restore it from session history; its own child is left as it was.
    expect(archivedAt('child-a')).not.toBeNull();
    expect(archivedAt('grandchild')).toBeNull();
    // The renderer drops the row from the session list on this event, as for an archive done in another window.
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'child-a', changes: { archivedAt: archivedAt('child-a') } })
    );
  });

  // 归档 = 侧栏不显示、会话历史里在:agent 的读数照列这一行,状态说它已经收起;没归档的兄弟不受影响。
  it('keeps an archived child in session_children and session_get with status archived', async () => {
    seedChild('child-a');
    seedChild('child-b');
    await runSessionAction(context, { action: 'archive', session_id: 'child-a' });

    const children = (await runSessionAction(context, { action: 'children' })) as Array<{ session_id: string; status: unknown }>;
    expect(Object.fromEntries(children.map((row) => [row.session_id, row.status]))).toEqual({
      'child-a': 'archived',
      'child-b': null,
    });
    await expect(runSessionAction(context, { action: 'get', session_id: 'child-a' })).resolves.toMatchObject({
      session_id: 'child-a',
      status: 'archived',
    });
  });

  it('with_children archives the whole subtree, leaf-first, through the same archiveSession', async () => {
    seedChild('child-a');
    seedChild('grandchild', 'child-a');
    seedChild('great-grandchild', 'grandchild');
    seedChild('child-b');

    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'child-a', with_children: true })
    ).resolves.toEqual({ session_id: 'child-a', archived: true, with_children: true, children_archived: 2 });
    expect(interruptedFor('archive')).toEqual([
      'great-grandchild',
      'grandchild',
      'child-a',
    ]);
    expect(mocks.stopSession).not.toHaveBeenCalled();
    for (const id of ['child-a', 'grandchild', 'great-grandchild']) expect(archivedAt(id), id).not.toBeNull();
    expect(archivedAt('child-b')).toBeNull();
  });

  it('says so when the session is already archived instead of reporting a second archive', async () => {
    seedChild('child-a');
    await runSessionAction(context, { action: 'archive', session_id: 'child-a' });
    mocks.lifeInterrupt.mockClear();

    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'child-a' })
    ).rejects.toThrow('session is already archived');
    expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
  });

  it('archives a session in the project it did not spawn, but never itself', async () => {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
         VALUES ('stranger', 'project-1', 'workspace-1', 'Stranger', 'claude', 'acp')`
      )
      .run();
    seedChild('sibling', 'stranger');

    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'sibling' })
    ).resolves.toMatchObject({ session_id: 'sibling', archived: true });
    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'stranger' })
    ).resolves.toMatchObject({ session_id: 'stranger', archived: true });
    expect(archivedAt('sibling')).not.toBeNull();
    expect(archivedAt('stranger')).not.toBeNull();

    mocks.lifeInterrupt.mockClear();
    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'caller' })
    ).rejects.toThrow('a session cannot archive itself');
    expect(archivedAt('caller')).toBeNull();
    expect(mocks.lifeInterrupt).not.toHaveBeenCalled();
  });

  // owner 2026-09-30 拍板跨机器之后 `session:<id>` 是账号级地址:本机别的项目里的会话也够得着(别的机器上的由宿主转过去)。
  it('reaches a session in another project on this machine', async () => {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime)
         VALUES ('elsewhere', 'project-2', 'Elsewhere', 'claude', 'acp')`
      )
      .run();
    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'elsewhere' })
    ).resolves.toEqual(expect.objectContaining({ session_id: 'elsewhere', archived: true }));
    expect(archivedAt('elsewhere')).not.toBeNull();
  });

  it('says a session that is on no project of this machine is not here', async () => {
    await expect(
      runSessionAction(context, { action: 'archive', session_id: 'on-another-machine' })
    ).rejects.toThrow('session not found on this machine');
  });
});

  // #6264 咕咕 server:没有本机渲染层,open_in_tab 交给正看着这条会话的桌面(remote-pane.ts)。
  describe('on a Gugu server (remote pane route)', () => {
    const open = vi.fn();
    beforeEach(() => {
      open.mockReset();
      setRemotePaneOpener({ open });
    });
    afterEach(() => setRemotePaneOpener(null));

    it('routes a file to the desktop viewing the session and never asks the local renderer', async () => {
      open.mockResolvedValue({ opened: true });
      await expect(runSessionAction(context, { action: 'open_in_tab', path: 'data/report.csv', intent: 'preview' }))
        .resolves.toEqual({ opened: true, path: '/repo/ws-1/data/report.csv', intent: 'preview' });
      expect(open).toHaveBeenCalledWith('caller', { kind: 'file', path: '/repo/ws-1/data/report.csv' }, 'preview', undefined);
      expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('answers at once with a queued result when no desktop has the session open', async () => {
      open.mockResolvedValue({ queued: true });
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'http://localhost:3000/', intent: 'pinned' }))
        .resolves.toEqual({ opened: false, queued: true, url: 'http://localhost:3000/', intent: 'pinned', note: REMOTE_PANE_QUEUED_NOTE });
      expect(open).toHaveBeenCalledWith('caller', { kind: 'browser', url: 'http://localhost:3000/' }, 'pinned', undefined);
    });

    it('still validates the path on this machine before routing it', async () => {
      mocks.stat.mockResolvedValueOnce({ success: false, error: { message: 'file does not exist: nope.txt' } });
      await expect(runSessionAction(context, { action: 'open_in_tab', path: 'nope.txt', intent: 'pinned' }))
        .rejects.toThrow('file does not exist');
      expect(open).not.toHaveBeenCalled();
    });

    it('refuses a file outside the working directory in plain words', async () => {
      await expect(runSessionAction(context, { action: 'open_in_tab', path: '/etc/hosts', intent: 'pinned' }))
        .rejects.toThrow(describeOutsideWorkspace('/repo/ws-1'));
      expect(open).not.toHaveBeenCalled();
    });

    it('routes a file:// page inside the working directory to the desktop browser tab, as locally', async () => {
      open.mockResolvedValue({ opened: true });
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'file:///repo/ws-1/site/report.html', intent: 'pinned' }))
        .resolves.toEqual({ opened: true, url: 'file:///repo/ws-1/site/report.html', intent: 'pinned' });
      expect(open).toHaveBeenCalledWith('caller', { kind: 'browser', url: 'file:///repo/ws-1/site/report.html' }, 'pinned', undefined);
      expect(mocks.stat).toHaveBeenCalledWith('/repo/ws-1/site/report.html');
    });

    it('refuses file:// pages outside the working directory, missing ones, and extension tabs fast', async () => {
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'file:///etc/passwd', intent: 'pinned' }))
        .rejects.toThrow(describePageOutsideWorkspace('/repo/ws-1'));
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'file:///repo/ws-1/../secret.html', intent: 'pinned' }))
        .rejects.toThrow(describePageOutsideWorkspace('/repo/ws-1'));
      mocks.stat.mockResolvedValueOnce({ success: false, error: { message: 'file does not exist' } });
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'file:///repo/ws-1/nope.html', intent: 'pinned' }))
        .rejects.toThrow(REMOTE_PANE_PAGE_NOT_FILE);
      await expect(runSessionAction(context, { action: 'open_in_tab', app_tab: 'sheets.grid', intent: 'pinned' }))
        .rejects.toThrow(REMOTE_PANE_NO_EXTENSIONS);
      expect(open).not.toHaveBeenCalled();
    });

    it('passes the route failure through as the tool error', async () => {
      open.mockRejectedValue(new RemotePaneError('no_browser'));
      await expect(runSessionAction(context, { action: 'open_in_tab', url: 'https://example.com', intent: 'pinned' }))
        .rejects.toThrow('remote tunnel');
    });
  });
});
