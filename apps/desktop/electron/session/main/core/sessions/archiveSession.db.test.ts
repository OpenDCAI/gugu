import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainSessionMessageOutbox } from './sendMessage';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import type { RemovedSessionIdentity } from '@gugu/core/shared/sessionArchival';
import { setTaskNamer } from './task-name';

// Sessions are named at creation by the host's namer (task-name.ts); number defaults per provider.
beforeEach(() => setTaskNamer({ defaultName: async (provider, taken) => `${provider} ${taken.length + 1}`, renameBound: async () => { throw new Error("no identities in this test") } }));
afterEach(() => setTaskNamer(null));

/**
 * spec session-graph 的归档合同,打在真 SQLite 上。
 *
 * 这里要证的是 #5413 的全部:①归档只动点名的那一行(**父/来源/兄弟一律不碰**);②「子会话」
 * 只有 spawn 出来的那种,fork 不是子。恢复接口 UI 上没有入口(owner 2026-09-11),它的正确性只能由这里作证。
 */
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  stopped: [] as string[],
  teardown: vi.fn(),
  mounted: new Set<string>(),
  userData: '',
  getProject: vi.fn(),
  // session-life owner of ACP sessions: archive/restore are asked of it, not of the ACP runtime client.
  life: {
    interrupt: vi.fn(async (_sessionId: string, _event: { k: 'interrupt'; reason: string }) => undefined),
    restore: vi.fn((_sessionId: string) => undefined),
  },
}));

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData }, clipboard: {}, nativeImage: {} }));
// Only the assistant ownership UI helper is replaced; close/delete/archive below are real.
vi.mock('@/lib/myAssistant', () => ({ isMyAssistant: () => false }));

vi.mock('./sendMessage', () => ({ drainSessionMessageOutbox: vi.fn(async () => undefined) }));
vi.mock('./session-life', () => ({ sessionLife: () => mocks.life }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
// 停 runtime 与收 tmux 不是这一层的命题:这里量的是「哪些行被动了」。ACP 归档不再直接停 runtime(交给 session-life),
// 这里记下的直接停应当始终为空。
vi.mock('@main/core/acp/controller', () => ({
  getAcpRuntimeClient: async () => ({
    stopSession: async ({ sessionId }: { sessionId: string }) => {
      mocks.stopped.push(sessionId);
      return { success: true };
    },
  }),
}));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: mocks.getProject } }));
// The folder guard below exercises real session preparation/commit; engines and
// account group bindings are external to directory membership and stay isolated.
vi.mock('@main/core/sessions/impl/harness-availability', () => ({ checkLocalHarnessAvailable: async () => null }));
vi.mock('@main/core/mcp-library/service', () => ({ mcpLibraryService: { list: async () => [] } }));
vi.mock('../projects/operations/project-groups', () => ({ listProjectGroupBindings: async () => ({ success: true, data: [] }) }));
vi.mock('@main/core/pty/tmux-session-name', () => ({
  killTmuxSession: vi.fn(),
  makeTmuxSessionName: (id: string) => id,
}));
vi.mock('@main/core/sessions/session-workspace-manager', () => ({
  sessionWorkspaceManager: {
    getSession: (id: string) => (mocks.mounted.has(id) ? {} : undefined),
    teardownSession: (...a: unknown[]) => mocks.teardown(...a),
    hooks: { on: vi.fn() },
  },
  cleanupDetachedSessions: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./session-events', () => ({ sessionEvents: { _emit: vi.fn() } }));

vi.mock('@main/core/session-import/host-source', () => ({ hasLocalSessionSource: () => false }));

vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({ prSyncEngine: { deleteProjectData: vi.fn() } }));
vi.mock('../../../../sessionpage/sessionpage-project-groups', () => ({ listProjectGroupIds: async () => [], forgetProjectGroupId: vi.fn() }));

const { getProjects } = await import('../projects/operations/getProjects');
const { listSessionHistory } = await import('../session-history/list-session-history');
const { archiveSession, restoreSession } = await import('./archiveSession');
const { setOtherMachines } = await import('./session-family');
const { events } = await import('@main/lib/events');
const { sessionCreatedChannel } = await import('@shared/core/sessions/sessionEvents');
const { sessionEvents } = await import('./session-events');
const { setSessionIdentityHost } = await import('./session-identity-host');
const identityHost = {
  archive: vi.fn(async (_sessionId: string, confirmedRemoval?: RemovedSessionIdentity): Promise<RemovedSessionIdentity | null> => confirmedRemoval ?? null),
  release: vi.fn(async (_identity: RemovedSessionIdentity) => {}),
  restore: vi.fn(async (_target: { projectId: string; sessionId: string }, _identity: RemovedSessionIdentity) => {}),
};

beforeEach(async () => {
  mocks.userData = await mkdtemp(join(tmpdir(), 'gugu-agent-delete-files-'));
  mocks.life.interrupt.mockReset();
  mocks.life.interrupt.mockResolvedValue(undefined);
  mocks.life.restore.mockReset();
  identityHost.archive.mockReset(); identityHost.archive.mockImplementation(async (_id, receipt) => receipt ?? null);
  identityHost.release.mockReset(); identityHost.restore.mockReset();
  setSessionIdentityHost(identityHost);
});
/** Sessions session-life was asked to archive, in call order (every interrupt here must carry reason 'archive'). */
const archivedByLife = () => mocks.life.interrupt.mock.calls.map(([sessionId, event]) => {
  expect(event).toEqual({ k: 'interrupt', reason: 'archive' });
  return sessionId;
});
afterEach(async () => { setSessionIdentityHost(null); await rm(mocks.userData, { recursive: true, force: true }); });

describe('archiveSession', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  /**
   * 一条会话行。`parent` = 挂在谁下面(子会话只认这条边),`spawnedBy` = 谁派的(来历);`fork` 只写 config 里的
   * transcript 血缘;`remoteParent` = 挂在别的机器上的那条会话下面(config.parentRemote)。
   */
  const insertSession = (
    id: string,
    opts: { parent?: string; spawnedBy?: string; fork?: string; remoteParent?: string } = {}
  ) => {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions
           (id, project_id, runtime, parent_session_id, spawned_by_session_id, config)
         VALUES (?, 'p1', 'acp', ?, ?, ?)`
      )
      .run(
        id,
        opts.parent ?? null,
        opts.spawnedBy ?? null,
        JSON.stringify({
          version: '1',
          type: 'acp',
          agentDisplayName: id,
          ...(opts.fork ? { forkedFrom: { sessionId: opts.fork } } : {}),
          ...(opts.remoteParent ? { parentRemote: { deviceId: 'dev-b', sessionId: opts.remoteParent } } : {}),
        })
      );
  };

  const archivedAt = (id: string) =>
    (
      fixture.sqlite.prepare(`SELECT archived_at FROM sessions WHERE id = ?`).get(id) as
        | { archived_at: string | null }
        | undefined
    )?.archived_at ?? null;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.stopped = []
    mocks.teardown.mockReset()
    mocks.teardown.mockResolvedValue({ success: true })
    mocks.mounted.clear()
    mocks.getProject.mockReset();
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('waits for the cloud receipt before any local archival and leaves failure retryable', async () => {
    insertSession('needs-cloud');
    const receipt = Promise.withResolvers<RemovedSessionIdentity | null>();
    identityHost.archive.mockReturnValueOnce(receipt.promise);
    const pending = archiveSession('p1', 'needs-cloud');
    await vi.waitFor(() => expect(identityHost.archive).toHaveBeenCalledWith('needs-cloud', undefined));
    expect(archivedAt('needs-cloud')).toBeNull();
    expect(mocks.stopped).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT key FROM kv WHERE key='session-archival:needs-cloud'").get()).toBeUndefined();
    receipt.reject(new Error('Identity removal needs a connection'));
    await expect(pending).rejects.toThrow('needs a connection');
    expect(archivedAt('needs-cloud')).toBeNull();
    expect(identityHost.release).not.toHaveBeenCalled();
    identityHost.archive.mockResolvedValueOnce({ userId: 'old-identity', removedAt: '2026-10-31T00:00:00Z' });
    await archiveSession('p1', 'needs-cloud');
    expect(archivedAt('needs-cloud')).not.toBeNull();
    expect(identityHost.release).toHaveBeenCalledWith({ userId: 'old-identity', removedAt: '2026-10-31T00:00:00Z' });
  });

  it('keeps the existing offline archive and restore path when removal is explicitly false', async () => {
    insertSession('offline');
    setSessionIdentityHost(null);
    await archiveSession('p1', 'offline', { removeSocialIdentity: false });
    expect(archivedAt('offline')).not.toBeNull();
    await expect(restoreSession('p1', 'offline')).resolves.toMatchObject({ id: 'offline', archivedAt: null });
    expect(identityHost.archive).not.toHaveBeenCalled();
    expect(identityHost.restore).not.toHaveBeenCalled();
  });

  it('restores the same session with history, files and config while replacing only its removed identity', async () => {
    insertSession('same-task');
    const file = join(mocks.userData, 'retained.txt');
    await writeFile(file, 'the original task file');
    const config = JSON.stringify({ version: '1', type: 'acp', model: 'original-model', agentDisplayName: 'same-task' });
    fixture.sqlite.prepare('UPDATE sessions SET config=? WHERE id=?').run(config, 'same-task');
    fixture.sqlite.prepare("INSERT INTO messages (id, session_id, content, sender) VALUES ('old-message', 'same-task', 'original history', 'user')").run();
    fixture.sqlite.prepare("INSERT INTO session_attachments (id, session_id, name, size, stored_path, origin) VALUES ('old-file', 'same-task', 'retained.txt', 22, ?, 'copy')").run(file);
    const receipt = { userId: 'old-identity', removedAt: '2026-10-31T00:00:00Z' };
    identityHost.archive.mockResolvedValueOnce(receipt);
    await archiveSession('p1', 'same-task');
    identityHost.restore.mockRejectedValueOnce(new Error('new identity provisioning unavailable'));
    await expect(restoreSession('p1', 'same-task')).rejects.toThrow('provisioning unavailable');
    expect(archivedAt('same-task')).not.toBeNull();
    await restoreSession('p1', 'same-task');
    expect(identityHost.restore).toHaveBeenLastCalledWith({ projectId: 'p1', sessionId: 'same-task' }, receipt);
    expect(fixture.sqlite.prepare('SELECT id, project_id, config, archived_at FROM sessions').all()).toEqual([{ id: 'same-task', project_id: 'p1', config, archived_at: null }]);
    expect(fixture.sqlite.prepare('SELECT session_id, content FROM messages').all()).toEqual([{ session_id: 'same-task', content: 'original history' }]);
    expect(fixture.sqlite.prepare('SELECT stored_path FROM session_attachments').all()).toEqual([{ stored_path: file }]);
    expect(existsSync(file)).toBe(true);
  });

  it.each(['PR cleanup', 'task archival'])('retains a task and messages arriving during %s when removing a project', async (boundary) => {
    const { prSyncEngine } = await import('../pull-requests/pr-sync-engine');
    const { deleteProject } = await import('../projects/operations/deleteProject');
    fixture.sqlite.exec("INSERT INTO workspaces (id,type,kind,location,path,key) VALUES ('late-root','local','project-root','local','/repo','late-root'); UPDATE projects SET repository_workspace_id='late-root' WHERE id='p1';");
    const arrive = () => {
      insertSession('late-task');
      fixture.sqlite.prepare("INSERT INTO messages (id, session_id, content, sender) VALUES ('late-message', 'late-task', 'Keep the original message', 'user')").run();
      expect(fixture.sqlite.prepare("SELECT id FROM sessions WHERE id='late-task'").get()).toEqual({ id: 'late-task' });
    };
    if (boundary === 'PR cleanup') {
      expect(fixture.sqlite.prepare("SELECT id FROM sessions WHERE project_id='p1'").all()).toEqual([]);
      vi.mocked(prSyncEngine.deleteProjectData).mockImplementationOnce(async () => { arrive(); });
    } else {
      insertSession('original-task');
      mocks.mounted.add('original-task');
      mocks.teardown.mockImplementationOnce(async () => { arrive(); return { success: true }; });
    }
    await deleteProject('p1');
    expect(fixture.sqlite.prepare("SELECT id FROM projects WHERE id='p1'").get()).toEqual({ id: 'p1' });
    expect(fixture.sqlite.prepare("SELECT id FROM sessions WHERE id='late-task'").get()).toEqual({ id: 'late-task' });
    expect(archivedAt('late-task')).not.toBeNull();
    await expect(restoreSession('p1', 'late-task')).resolves.toMatchObject({ id: 'late-task', archivedAt: null });
    expect(fixture.sqlite.prepare("SELECT session_id, content FROM messages WHERE id='late-message'").get()).toEqual({ session_id: 'late-task', content: 'Keep the original message' });
    if (boundary === 'task archival') expect(archivedAt('original-task')).not.toBeNull();
  });

  it('project removal retains real tasks through the actual reaper; only a genuine missing task is marked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-archive-roster-'));
    const env = { GUGU_HOME: home };
    const { createAgent, updateAgent, listAgents } = await import('@gugu/core');
    const { reconcileSessionpageAgents } = await import('../../../../sessionpage/sessionpage-agent-reaper');
    const bind = async (id: string, sessionId: string) => {
      await createAgent({ name: id, gugu_user_id: id, agent_type: 'codex' }, env);
      await updateAgent({ guguUserId: id }, { cache: { emdash_session_id: sessionId, sessionpage_owner_user_id: 'owner' } }, env);
    };
    const deps = {
      env, getAuth: async () => ({ userId: 'owner', accessToken: 'unused', refreshToken: 'unused' }),
      resolveDeviceId: async () => 'device',
      getInventory: async () => ({
        sessionIds: (fixture.sqlite.prepare('SELECT id FROM sessions').all() as { id: string }[]).map(row => row.id), projectIds: ['p1'],
      }),
    };
    try {
      insertSession('incident');
      await bind('kept-identity', 'incident');
      fixture.sqlite.exec("INSERT INTO workspaces (id,type,kind,location,path,key) VALUES ('incident-root','local','project-root','local','/repo','incident-root'); UPDATE projects SET repository_workspace_id='incident-root' WHERE id='p1';");
      await (await import('../projects/operations/deleteProject')).deleteProject('p1');
      expect(await reconcileSessionpageAgents(deps)).toEqual({ reapedAgents: 0, archivedGroups: 0 });
      expect(archivedAt('incident')).not.toBeNull();
      await bind('orphan-identity', 'legacy-missing');
      expect(await reconcileSessionpageAgents(deps)).toEqual({ reapedAgents: 1, archivedGroups: 0 });
      const roster = await listAgents(env);
      expect(roster.find(row => row.gugu_user_id === 'orphan-identity')?.status).toBe('archived');
      expect(roster.find(row => row.gugu_user_id === 'kept-identity')?.status).not.toBe('archived');
      await restoreSession('p1', 'incident');
      expect(archivedAt('incident')).toBeNull();
      expect(fixture.sqlite.prepare("SELECT id FROM sessions WHERE id='incident'").get()).toEqual({ id: 'incident' });
    } finally { await rm(home, { recursive: true }); }
  });

  it('restores every original project folder, including an unused one, without reattaching or changing identities', async () => {
    const root = join(mocks.userData, 'project');
    const used = join(mocks.userData, 'used');
    const unused = join(mocks.userData, 'unused');
    for (const path of [root, used, unused]) await mkdir(path);
    await writeFile(join(unused, 'keep.txt'), 'original file');
    fixture.sqlite.prepare("UPDATE projects SET path=?, repository_workspace_id='restore-root' WHERE id='p1'").run(root);
    const insertFolder = fixture.sqlite.prepare('INSERT INTO workspaces (id,type,kind,location,path,key,project_id,attached_at) VALUES (?,\'local\',?,\'local\',?,?,?,?)');
    insertFolder.run('restore-root', 'project-root', root, root, null, null);
    insertFolder.run('restore-used', 'path', used, used, 'p1', '2026-10-29T01:00:00Z');
    insertFolder.run('restore-unused', 'path', unused, unused, 'p1', '2026-10-29T02:00:00Z');
    insertSession('folder-task');
    fixture.sqlite.prepare("UPDATE sessions SET workspace_id='restore-used' WHERE id='folder-task'").run();
    const { listProjectFolderRefs, resolveProjectFolder } = await import('../projects/operations/project-folders');
    const { listDeviceProjectRecords } = await import('../projects/operations/device-project-records');
    const before = await listProjectFolderRefs('p1');
    expect(before).toHaveLength(3);
    const rows = fixture.sqlite.prepare('SELECT id, project_id, attached_at, path FROM workspaces ORDER BY id').all();

    await (await import('../projects/operations/deleteProject')).deleteProject('p1');
    expect(await getProjects()).toEqual([]);
    expect(await listDeviceProjectRecords()).toEqual([]);
    expect((await getProjects({ includeHidden: true })).map(project => project.id)).toContain('p1');
    expect(fixture.sqlite.prepare('SELECT id, project_id, attached_at, path FROM workspaces ORDER BY id').all()).toEqual(rows);

    await restoreSession('p1', 'folder-task');
    const after = await listProjectFolderRefs('p1');
    expect(after).toHaveLength(before!.length);
    expect(after).toEqual(before);
    expect((await getProjects()).map(project => project.id)).toContain('p1');
    expect((await listDeviceProjectRecords())[0]?.folders).toEqual(before);
    expect(fixture.sqlite.prepare('SELECT id, project_id, attached_at, path FROM workspaces ORDER BY id').all()).toEqual(rows);
    const { prepareCreateSession, commitCreateSession } = await import('./operations/createSession');
    mocks.getProject.mockReturnValue({});
    for (const folder of after!) {
      expect(await resolveProjectFolder('p1', folder.workspaceId)).not.toBeNull();
      const id = `new-task-${folder.workspaceId}`;
      const prepared = await prepareCreateSession({ projectId: 'p1',
        sessionConfig: { version: '1', name: id, initialSession: { id, provider: 'codex',
          title: id, origin: { kind: 'create', firstUtterance: 'Continue work' } } },
        workspaceConfig: { version: '2', workspace: { kind: 'repository-instance', workspaceId: folder.workspaceId } },
      });
      expect(prepared.success).toBe(true);
      if (!prepared.success) throw new Error(JSON.stringify(prepared.error));
      const created = fixture.db.transaction(tx => commitCreateSession(prepared.data, tx));
      expect(created).toMatchObject({ id, projectId: 'p1', workspaceId: folder.workspaceId });
    }
    expect(await (await import('node:fs/promises')).readFile(join(unused, 'keep.txt'), 'utf8')).toBe('original file');
  });

  it('无目录项目归档后隐藏,历史仍能恢复原会话与工作区,重读清单也保留', async () => {
    fixture.sqlite.exec(`
      UPDATE projects SET root_folder_detached = 1 WHERE id = 'p1';
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('historic-ws', 'path', 'local', 'local', '/repo', 'historic-key');
      INSERT INTO sessions (id, project_id, workspace_id, runtime, provider_session_id, config)
        VALUES ('historic-session', 'p1', 'historic-ws', 'acp', 'provider-original',
          json_object('version', '1', 'type', 'acp', 'agentDisplayName', 'history survives'));
    `);
    const originalTurn = JSON.stringify({ id: 'original-turn', seq: 0, initiator: 'user', items: [{ kind: 'message', id: 'original-message', seq: 0, role: 'user', text: '完整时间线必须保留' }] });
    fixture.sqlite.prepare(`INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('historic-session:0', 'historic-session', 0, 'original-turn', ?)`)
      .run(originalTurn);
    expect((await getProjects()).map((project) => project.id)).toContain('p1');
    await archiveSession('p1', 'historic-session');
    expect(await getProjects()).toEqual([]);
    const history = await listSessionHistory({ source: 'gugu', status: 'archived' });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ title: 'history survives', gugu: { projectId: 'p1', sessionId: 'historic-session' } });

    const restored = await restoreSession('p1', 'historic-session');
    expect(restored).toMatchObject({ id: 'historic-session', projectId: 'p1', workspaceId: 'historic-ws', archivedAt: null });
    expect(fixture.sqlite.prepare(`SELECT id, workspace_id, provider_session_id FROM sessions`).all()).toEqual([
      { id: 'historic-session', workspace_id: 'historic-ws', provider_session_id: 'provider-original' },
    ]);
    expect((await getProjects()).map((project) => project.id)).toEqual(['p1']);
    expect((await listSessionHistory({ source: 'gugu', status: 'active' })).rows).toHaveLength(1);
    expect(fixture.sqlite.prepare('SELECT session_id, data FROM session_turns').all()).toEqual([{ session_id: 'historic-session', data: originalTurn }]);
  });

  it('报回这一次真正收走的行:子会话在前、点名的在后;已经归档的不算 —— 撤销按它放回(#6083)', async () => {
    insertSession('parent');
    insertSession('child', { parent: 'parent' });
    insertSession('grandchild', { parent: 'child' });
    insertSession('already', { parent: 'parent' });
    expect(await archiveSession('p1', 'already')).toEqual({
      archived: [{ projectId: 'p1', sessionId: 'already' }],
      unreached: [],
    });

    const { archived } = await archiveSession('p1', 'parent', { withChildren: true });

    expect(archived.map((ref) => ref.sessionId)).toEqual(['grandchild', 'child', 'parent']);
    // 已经归档过的再归一次:什么都没收走,清单为空 —— 撤销不该把它当成这一次的。
    expect(await archiveSession('p1', 'parent')).toEqual({ archived: [], unreached: [] });
  });

  it('归档一条 fork 会话,来源会话一个字都不动 —— #5413', async () => {
    insertSession('origin');
    insertSession('the-fork', { fork: 'origin' });

    await archiveSession('p1', 'the-fork');

    expect(archivedAt('the-fork')).not.toBeNull();
    // 阴控落在这一行:#5413 之前归档落在容器上,于是来源会话跟着从列表消失。
    expect(archivedAt('origin')).toBeNull();
    expect(archivedByLife()).toEqual(['the-fork']);
    expect(mocks.stopped).toEqual([]);
  });

  it('归档 spawn 出来的子会话,父会话原样留下', async () => {
    insertSession('parent');
    insertSession('child', { parent: 'parent', spawnedBy: 'parent' });

    await archiveSession('p1', 'child');

    expect(archivedAt('child')).not.toBeNull();
    expect(archivedAt('parent')).toBeNull();
  });

  it('不勾范围:只归档这一条,它的子会话留在列表里', async () => {
    insertSession('parent');
    insertSession('child', { parent: 'parent' });
    insertSession('grandchild', { parent: 'child' });

    await archiveSession('p1', 'parent');

    expect(archivedAt('parent')).not.toBeNull();
    expect(archivedAt('child')).toBeNull();
    expect(archivedAt('grandchild')).toBeNull();
  });

  it('勾了范围:挂在它下面的整棵子树一起归档,runtime 全停', async () => {
    insertSession('parent');
    insertSession('child', { parent: 'parent', spawnedBy: 'parent' });
    insertSession('grandchild', { parent: 'child' });
    insertSession('bystander');

    await archiveSession('p1', 'parent', { withChildren: true });

    expect(archivedAt('parent')).not.toBeNull();
    expect(archivedAt('child')).not.toBeNull();
    expect(archivedAt('grandchild')).not.toBeNull();
    expect(archivedAt('bystander')).toBeNull();
    // ACP runtime 全停 = 每一条都由 session-life 的 archive 迁移停下。
    expect(archivedByLife().sort()).toEqual(['child', 'grandchild', 'parent']);
    expect(mocks.stopped).toEqual([]);
  });

  // owner 2026-10-08:子会话 = 挂在你下面的。派出去但没挂(nest:false)的是给人用的,不跟着收;
  // 改挂到别处的跟着新的父会话走。
  it('勾了范围只顺着「挂在谁下面」走:派出去没挂的、改挂到别处的都不收', async () => {
    insertSession('parent');
    insertSession('other');
    insertSession('standalone', { spawnedBy: 'parent' });
    insertSession('moved', { parent: 'other', spawnedBy: 'parent' });
    insertSession('adopted', { parent: 'parent', spawnedBy: 'other' });

    await archiveSession('p1', 'parent', { withChildren: true });

    expect(archivedAt('adopted')).not.toBeNull();
    expect(archivedAt('standalone')).toBeNull();
    expect(archivedAt('moved')).toBeNull();
  });

  it('勾了范围也不碰 fork —— fork 与来源是平行同级,不是子会话', async () => {
    insertSession('origin');
    insertSession('its-fork', { fork: 'origin' });

    await archiveSession('p1', 'origin', { withChildren: true });

    expect(archivedAt('origin')).not.toBeNull();
    expect(archivedAt('its-fork')).toBeNull();
  });

  it('挂载着的会话:收起它的挂载(工作区留着,恢复后接着用),不再另停一次 runtime', async () => {
    insertSession('mounted');
    mocks.mounted.add('mounted');

    await archiveSession('p1', 'mounted');

    expect(archivedAt('mounted')).not.toBeNull();
    expect(mocks.teardown).toHaveBeenCalledWith('mounted', 'archive');
    // ACP 腿由 session-life 的 archive 迁移停下(恰一次),挂载外不另停 runtime。
    expect(archivedByLife()).toEqual(['mounted']);
    expect(mocks.stopped).toEqual([]);
  });

  it('ACP:先让 session-life 归档(拒收后续投递、结掉排队的),归档标记随后才落', async () => {
    insertSession('acp-task');
    mocks.life.interrupt.mockImplementationOnce(async (sessionId) => {
      expect(archivedAt(sessionId)).toBeNull();
    });

    await archiveSession('p1', 'acp-task');

    expect(archivedByLife()).toEqual(['acp-task']);
    expect(archivedAt('acp-task')).not.toBeNull();
  });

  it('ACP:session-life 归档失败就不落归档标记,失败原样抛出', async () => {
    insertSession('acp-refused');
    mocks.life.interrupt.mockRejectedValueOnce(new Error('archive transition failed'));

    await expect(archiveSession('p1', 'acp-refused')).rejects.toThrow('archive transition failed');

    expect(archivedAt('acp-refused')).toBeNull();
  });

  it('非 ACP 会话不经 session-life 归档', async () => {
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, title, runtime) VALUES ('pty-task', 'p1', 'pty-task', NULL)`).run();

    await archiveSession('p1', 'pty-task');

    expect(archivedAt('pty-task')).not.toBeNull();
    expect(mocks.life.interrupt).not.toHaveBeenCalled();
  });

  it('已经归档过的会话再归档是空动作,不会二次停 runtime', async () => {
    insertSession('a');
    insertSession('b');
    await archiveSession('p1', 'a');
    expect(archivedByLife()).toEqual(['a']);
    mocks.life.interrupt.mockClear();

    await archiveSession('p1', 'a');

    expect(mocks.life.interrupt).not.toHaveBeenCalled();
    expect(mocks.stopped).toEqual([]);
  });

  it('点名一条不在这个项目里的会话时响亮失败', async () => {
    insertSession('a');
    await expect(archiveSession('p-nope', 'a')).rejects.toThrow(/not found/i);
  });

  // owner 2026-10-01「一起收」「链路统一」:按父子关系找出各台机器上的后代,每一条走它所在机器上的单条归档。
  describe('连同子会话跨机器', () => {
    afterEach(() => setOtherMachines(null));

    // 别的机器报来的是界面那份列表的行(整行),这里只填归档要读的几格。
    const remote = (id: string, deviceId: string, parent: string | null) => ({
      deviceId,
      label: deviceId,
      session: { conversationId: id, projectId: `p-${deviceId}`, parentConversationId: parent } as SessionpageSessionSummary,
      listsAgents: true,
    });
    const appMessage = vi.fn();
    const appReadFile = vi.fn();
    const appCall = vi.fn();

    it('两台的表拼起来找后代,叶子先、每一条在它自己那台机器上收,收走的都在清单里', async () => {
      insertSession('parent');
      insertSession('local-child', { parent: 'parent' });
      // 本机的孙会话挂在 B 上那个 child 下面 —— 只有把两台的表拼起来才找得到。
      insertSession('local-grandchild', { remoteParent: 'b-child' });
      const archivedThere: string[] = [];
      const sessions = vi.fn(async (_since: string | null) => ({
        sessions: [
          remote('b-child', 'dev-b', 'parent'),
          remote('c-grandchild', 'dev-c', 'b-child'),
          remote('b-stranger', 'dev-b', null),
        ],
        unreached: [{ deviceId: 'dev-d', label: 'dev-d', detail: 'offline' }],
      }));
      setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(),
        sessions,
        archive: async (_deviceId, sessionId) => {
          archivedThere.push(sessionId);
        },
        appMessage,
        appReadFile,
        appCall,
      });

      const outcome = await archiveSession('p1', 'parent', { withChildren: true });

      expect(outcome.archived.map((ref) => ref.sessionId)).toEqual([
        'c-grandchild',
        'local-grandchild',
        'b-child',
        'local-child',
        'parent',
      ]);
      // 别的机器上的行按它所在的项目记,撤销照着走回那台机器。
      expect(outcome.archived[0]).toEqual({ projectId: 'p-dev-c', sessionId: 'c-grandchild' });
      expect(archivedThere).toEqual(['c-grandchild', 'b-child']);
      expect(archivedAt('local-grandchild')).not.toBeNull();
      expect(outcome.unreached).toEqual([{ deviceId: 'dev-d', label: 'dev-d', detail: 'offline' }]);
      // 离线机器按「这棵树建好之后还在线过」筛:交过去的是根建好的时刻。
      expect(sessions.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('那台机器收不动的那一条说出来,别的照收;问不到别的机器也说出来', async () => {
      insertSession('parent');
      insertSession('child', { parent: 'parent' });
      setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(),
        sessions: async () => ({ sessions: [remote('b-child', 'dev-b', 'parent')], unreached: [] }),
        archive: async () => {
          throw new Error('on "dev-b" (device:dev-b): failed to stop ACP conversation');
        },
        appMessage,
        appReadFile,
        appCall,
      });
      expect(await archiveSession('p1', 'parent', { withChildren: true })).toEqual({
        archived: [
          { projectId: 'p1', sessionId: 'child' },
          { projectId: 'p1', sessionId: 'parent' },
        ],
        unreached: [{ deviceId: 'dev-b', label: 'dev-b', detail: 'on "dev-b" (device:dev-b): failed to stop ACP conversation' }],
      });

      insertSession('second');
      setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(),
        sessions: async () => {
          throw new Error('not signed in');
        },
        archive: vi.fn(),
        appMessage,
        appReadFile,
        appCall,
      });
      expect((await archiveSession('p1', 'second', { withChildren: true })).unreached).toEqual([
        { deviceId: null, label: null, detail: 'other machines were not asked (not signed in)' },
      ]);
      expect(archivedAt('second')).not.toBeNull();
    });

    it('不勾「连同子会话」就只动点名的这一条,别的机器一台都不问', async () => {
      insertSession('only');
      const sessions = vi.fn();
      setOtherMachines({ devices: async () => [], isThisDevice: async () => false, appSpawn: vi.fn(), sessions, archive: vi.fn(), appMessage, appReadFile, appCall });
      await archiveSession('p1', 'only');
      expect(sessions).not.toHaveBeenCalled();
    });
  });
});

describe('restoreSession(内部接口,UI 上没有入口)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.teardown.mockReset()
    mocks.teardown.mockResolvedValue({ success: true })
    mocks.mounted.clear()
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const insert = (id: string, runtime: 'acp' | null = 'acp') =>
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, runtime, config)
         VALUES (?, 'p1', ?, json_object('version', '1', 'type', CASE WHEN ? = 'acp' THEN 'acp' ELSE 'pty' END, 'agentDisplayName', ?))`
      )
      .run(id, runtime, runtime, id);
  const archivedAt = (id: string) =>
    (fixture.sqlite.prepare(`SELECT archived_at FROM sessions WHERE id = ?`).get(id) as {
      archived_at: string | null
    }).archived_at;

  it('commits refusal before teardown finishes and serializes a concurrent restore', async () => {
    insert('concurrent');
    mocks.mounted.add('concurrent');
    const teardown = Promise.withResolvers<{ success: boolean }>();
    mocks.teardown.mockReturnValueOnce(teardown.promise);
    const archiving = archiveSession('p1', 'concurrent');
    await vi.waitFor(() => expect(mocks.teardown).toHaveBeenCalledWith('concurrent', 'archive'));
    expect(archivedAt('concurrent')).not.toBeNull();
    let restored = false;
    const restoring = restoreSession('p1', 'concurrent').then(() => { restored = true; });
    await Promise.resolve();
    expect(restored).toBe(false);
    expect(archivedAt('concurrent')).not.toBeNull();
    teardown.resolve({ success: true });
    await Promise.all([archiving, restoring]);
    expect(archivedAt('concurrent')).toBeNull();
    const { sessionArchivalState } = await import('./session-archival');
    expect(sessionArchivalState('concurrent')).toMatchObject({ revision: 2, archivedAt: null,
      intervals: [{ restoredAt: expect.any(String) }] });
  });

  it('upgrades an existing archive with the cloud receipt and retains both tasks and their history', async () => {
    vi.mocked(sessionEvents._emit).mockClear();
    insert('removed-agent');
    insert('kept-agent');
    for (const id of ['removed-agent', 'kept-agent']) {
      fixture.sqlite.prepare('INSERT INTO messages (id, session_id, content, sender) VALUES (?, ?, ?, ?)').run(`${id}:message`, id, 'history', 'user');
      fixture.sqlite.prepare('INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES (?, ?, 0, ?, ?)').run(`${id}:turn`, id, `${id}:provider-turn`, '[]');
      await archiveSession('p1', id, { removeSocialIdentity: false });
    }
    const originalAt = archivedAt('removed-agent');
    const receipt = { userId: 'removed-identity', removedAt: '2026-10-31T03:00:00Z' };
    await archiveSession('p1', 'removed-agent', {}, receipt);
    await archiveSession('p1', 'removed-agent', {}, receipt);
    expect(identityHost.archive).toHaveBeenCalledTimes(1);
    expect(archivedAt('removed-agent')).toBe(originalAt);
    expect(sessionEvents._emit).not.toHaveBeenCalledWith('session:deleted', expect.any(String));
    expect(fixture.sqlite.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: 'kept-agent' }, { id: 'removed-agent' }]);
    expect(fixture.sqlite.prepare('SELECT id FROM messages').all()).toHaveLength(2);
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns').all()).toHaveLength(2);
    await expect(restoreSession('p1', 'removed-agent')).resolves.toMatchObject({ id: 'removed-agent', archivedAt: null });
    expect(identityHost.restore).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', sessionId: 'removed-agent' }, receipt);
    await expect(restoreSession('p1', 'kept-agent')).resolves.toMatchObject({ id: 'kept-agent', archivedAt: null });
  });

  it('retains the receipt and binding when runtime stop fails, then retries without another cloud removal', async () => {
    insert('stop-failed');
    mocks.mounted.add('stop-failed');
    const receipt = { userId: 'removed-identity', removedAt: '2026-10-31T03:00:00Z' };
    mocks.teardown.mockRejectedValueOnce(new Error('runtime stop unavailable'));
    await expect(archiveSession('p1', 'stop-failed', {}, receipt)).rejects.toThrow('runtime stop unavailable');
    expect(archivedAt('stop-failed')).not.toBeNull();
    expect(identityHost.release).not.toHaveBeenCalled();
    const { sessionArchivalState } = await import('./session-archival');
    expect(sessionArchivalState('stop-failed')?.removedIdentity).toEqual(receipt);
    mocks.teardown.mockResolvedValueOnce({ success: true });
    await archiveSession('p1', 'stop-failed', {}, receipt);
    expect(identityHost.archive).toHaveBeenCalledTimes(1);
    expect(identityHost.release).toHaveBeenCalledExactlyOnceWith(receipt);
    await expect(restoreSession('p1', 'stop-failed')).resolves.toMatchObject({ id: 'stop-failed' });
  });

  it('retains attachments, activity, UI/model state and user files after confirmed identity removal', async () => {
    insert('retained');
    insert('untouched');
    const ownedDir = join(mocks.userData, 'task-attachments', 'retained');
    await mkdir(ownedDir, { recursive: true });
    const owned = join(ownedDir, 'copy.txt');
    const userFile = join(mocks.userData, 'user-original.txt');
    for (const file of [owned, userFile]) await writeFile(file, 'retained task content');
    for (const [id, origin, path] of [['copy', 'copy', owned], ['reference', 'reference', userFile]]) {
      fixture.sqlite.prepare('INSERT INTO session_attachments (id, session_id, name, size, stored_path, origin) VALUES (?, ?, ?, 1, ?, ?)').run(id, 'retained', id, path, origin);
    }
    for (const id of ['retained', 'untouched']) {
      fixture.sqlite.prepare("INSERT INTO activity_events (event_id, observed_at, kind, session_id, data) VALUES (?, 1, 'session.created', ?, '{}')").run(id, id);
      fixture.sqlite.prepare('INSERT INTO session_run_intervals (session_id, started_at, last_seen_at) VALUES (?, 1, 2)').run(id);
      fixture.sqlite.prepare("INSERT INTO session_model_sources (session_id, source, started_at) VALUES (?, 'gugu', 1)").run(id);
      fixture.sqlite.prepare("INSERT OR REPLACE INTO activity_session_projects (session_id, project_id) VALUES (?, 'p1')").run(id);
    }
    const { viewStateService } = await import('../view-state/view-state-service');
    const { recordSessionPlatformModel, sessionPlatformModel } = await import('./platform-model-selection');
    const { recordSessionOutput, sessionOutputs } = await import('./session-outputs');
    await viewStateService.save('session:retained', { open: true });
    await recordSessionPlatformModel('retained', { modelId: 'original-model' });
    await recordSessionOutput('retained', { kind: 'file', path: userFile });
    const model = await sessionPlatformModel('retained');
    const outputs = await sessionOutputs('retained');
    await archiveSession('p1', 'retained', {}, { userId: 'removed-identity', removedAt: '2026-10-31T03:00:00Z' });
    expect(existsSync(owned)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    for (const table of ['activity_events', 'session_run_intervals', 'session_model_sources', 'activity_session_projects']) {
      expect(fixture.sqlite.prepare(`SELECT session_id FROM ${table} ORDER BY session_id`).all()).toEqual([{ session_id: 'retained' }, { session_id: 'untouched' }]);
    }
    expect(fixture.sqlite.prepare('SELECT id FROM session_attachments').all()).toHaveLength(2);
    expect(await viewStateService.get('session:retained')).toEqual({ open: true });
    expect(await sessionPlatformModel('retained')).toEqual(model);
    expect(await sessionOutputs('retained')).toEqual(outputs);
  });

  it('serializes confirmed-removal archival with Restore without deleting the session', async () => {
    insert('archive-race');
    mocks.mounted.add('archive-race');
    const stopping = Promise.withResolvers<{ success: boolean }>();
    mocks.teardown.mockReturnValueOnce(stopping.promise);
    const receipt = { userId: 'removed-identity', removedAt: '2026-10-31T03:00:00Z' };
    const archiving = archiveSession('p1', 'archive-race', {}, receipt);
    await vi.waitFor(() => expect(mocks.teardown).toHaveBeenCalledWith('archive-race', 'archive'));
    const restoring = restoreSession('p1', 'archive-race');
    await Promise.resolve();
    expect(identityHost.restore).not.toHaveBeenCalled();
    stopping.resolve({ success: true });
    await archiving;
    await expect(restoring).resolves.toMatchObject({ id: 'archive-race', archivedAt: null });
    expect(identityHost.restore).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', sessionId: 'archive-race' }, receipt);
    expect(fixture.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'archive-race' }]);
  });

  it.each([false, true])('closes through real identity cleanup and SQLite archival, delete-started=%s', async (deleteStarted) => {
    insert('assistant-task');
    insert('assistant-unbound');
    insert('started-task');
    insert('other-task');
    const { closeLocalAssistant } = await import('@/lib/assistantClose');
    const { createAgentSchedule, getAutomation, listAutomations, softDeleteAutomation } = await import('../automations/repo');
    const schedules = new Map<string, string>();
    for (const sessionId of ['assistant-task', 'assistant-unbound', 'started-task', 'other-task']) {
      const { automation } = await createAgentSchedule({
        agentSessionId: sessionId, projectId: 'p1', name: sessionId,
        prompt: 'Continue the original task', provider: 'codex',
        triggerConfig: { expr: '', at: Date.now() + 3_600_000, tz: 'UTC' },
      });
      schedules.set(sessionId, automation.id);
    }
    const startedSchedule = schedules.get('started-task')!;
    const originalSchedule = fixture.sqlite.prepare('SELECT * FROM automations WHERE id = ?').get(startedSchedule);
    const originalRuns = fixture.sqlite.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(startedSchedule);
    const { createAgent, updateAgent, listAgents } = await import('@gugu/core');
    const home = await mkdtemp(join(tmpdir(), 'gugu-close-chain-'));
    const env = { GUGU_HOME: home };
    const binding = new Map([['assistant-id', 'assistant-task'], ['child-id', 'started-task']]);
    for (const [agentId, sessionId] of binding) {
      await createAgent({ name: agentId, gugu_user_id: agentId, agent_type: 'codex' }, env);
      await updateAgent({ guguUserId: agentId }, { cache: { emdash_session_id: sessionId, sessionpage_owner_user_id: 'owner' } }, env);
    }
    const summary = (id: string, agentId: string) => ({ conversationId: id, projectId: 'p1', title: id, agent: { userId: agentId } });
    const own = summary('assistant-task', 'assistant-id');
    const unbound = summary('assistant-unbound', 'assistant-id');
    const child = summary('started-task', 'child-id');
    const removedIdentities: string[] = [];
    const { releaseAgentLocalFootprint } = await import('../../../../sessionpage/agent-local-footprint');
    identityHost.release.mockImplementation(async identity => {
      await releaseAgentLocalFootprint({ agentUserId: identity.userId, identityRemoved: true, env });
    });
    const wipeHome = vi.fn(async () => {});
    const resetLocalState = vi.fn();
    try {
      await closeLocalAssistant({ assistantId: 'assistant-id', deleteStarted }, { own: [own, unbound], started: [child] }, {
        listSessions: async () => [own, unbound, child].filter(session => fixture.sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get(session.conversationId)),
        // Use the real SQLite repository at the automation RPC boundary. Close,
        // identity cleanup, archive and Restore below keep their real implementation.
        listAutomations,
        deleteAutomation: async id => { await softDeleteAutomation(id); },
        removeAgent: async agentId => {
          removedIdentities.push(agentId); // Inject only the cloud single-write receipt.
          const sessionId = binding.get(agentId)!;
          await archiveSession('p1', sessionId, {}, { userId: agentId, removedAt: '2026-10-31T03:00:00Z' });
        },
        archiveSession: async (projectId, sessionId) => { await archiveSession(projectId, sessionId, { removeSocialIdentity: false }); },
        wipeHome, resetLocalState,
      });
      expect(wipeHome).toHaveBeenCalledOnce();
      expect(resetLocalState).toHaveBeenCalledOnce();
      expect(removedIdentities).toEqual(deleteStarted ? ['child-id', 'assistant-id'] : ['assistant-id']);
      const history = await listSessionHistory({ source: 'gugu', status: 'archived' });
      expect(history.rows.map(row => row.gugu?.sessionId).sort()).toEqual(['assistant-task', 'assistant-unbound', 'started-task']);
      expect(archivedAt('assistant-unbound')).not.toBeNull();
      await expect(restoreSession('p1', 'assistant-task')).resolves.toMatchObject({ id: 'assistant-task' });
      expect(await getAutomation(schedules.get('assistant-task')!)).toBeNull();
      expect(await getAutomation(schedules.get('assistant-unbound')!)).toBeNull();
      expect(await getAutomation(schedules.get('other-task')!)).toMatchObject({ agentSessionId: 'other-task', enabled: true });
      if (deleteStarted) {
        expect(await getAutomation(startedSchedule)).toBeNull();
        await expect(restoreSession('p1', 'started-task')).resolves.toMatchObject({ id: 'started-task' });
        expect(await listAgents(env)).toEqual([]);
      } else {
        expect((await listAgents(env)).map(agent => agent.gugu_user_id)).toEqual(['child-id']);
        expect(await getAutomation(startedSchedule)).toMatchObject({
          id: startedSchedule, agentSessionId: 'started-task', enabled: true,
          agentSession: { archived: true, gone: false },
        });
        expect(fixture.sqlite.prepare('SELECT * FROM automations WHERE id = ?').get(startedSchedule)).toEqual(originalSchedule);
        expect(fixture.sqlite.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(startedSchedule)).toEqual(originalRuns);
        await expect(restoreSession('p1', 'started-task')).resolves.toMatchObject({ id: 'started-task', archivedAt: null });
        const restoredSchedule = (await listAutomations()).find(row => row.id === startedSchedule);
        expect(restoredSchedule).toMatchObject({ id: startedSchedule, agentSessionId: 'started-task', enabled: true });
        expect(restoredSchedule?.agentSession?.archived).toBeUndefined();
        expect(fixture.sqlite.prepare('SELECT * FROM automation_runs WHERE automation_id = ?').all(startedSchedule)).toEqual(originalRuns);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it('把这条会话放回列表', async () => {
    insert('a');
    insert('b');
    await archiveSession('p1', 'a');
    expect(archivedAt('a')).not.toBeNull();
    vi.mocked(events.emit).mockClear();

    await restoreSession('p1', 'a');

    expect(archivedAt('a')).toBeNull();
    expect(archivedAt('b')).toBeNull();
    // 归档事件到达时每个窗口都收起了这一行 ⇒ 恢复要说「这一行出现了」并带上整行,每个窗口(含别的机器上看
    // 这台的窗口)都放回;❌ 只发一个字段变更(#6873 Z2:那台的侧栏不回来)。
    expect(vi.mocked(events.emit)).toHaveBeenCalledWith(sessionCreatedChannel, {
      session: expect.objectContaining({ id: 'a', archivedAt: null }),
    });
  });
  // Retargeted to PTY (runtime null): the legacy outbox drain on restore now applies only to non-ACP sessions.
  it('drains only the restored task once after releasing its archival lock', async () => {
    insert('restore-owner', null); insert('other-owner', null);
    await archiveSession('p1', 'restore-owner');
    vi.mocked(drainSessionMessageOutbox).mockClear();
    vi.mocked(drainSessionMessageOutbox).mockImplementationOnce(async () => {
      const { serializeSessionArchival } = await import('./session-archival');
      await serializeSessionArchival('restore-owner', async () => undefined);
    });
    await restoreSession('p1', 'restore-owner');
    expect(drainSessionMessageOutbox).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', sessionId: 'restore-owner' });
    expect(mocks.life.restore).not.toHaveBeenCalled();
  });

  it('ACP restore hands the session back to session-life (dormant, not started) and never drains the legacy outbox', async () => {
    insert('acp-restore'); insert('acp-other');
    await archiveSession('p1', 'acp-restore');
    vi.mocked(drainSessionMessageOutbox).mockClear();

    await expect(restoreSession('p1', 'acp-restore')).resolves.toMatchObject({ id: 'acp-restore', archivedAt: null });

    expect(mocks.life.restore).toHaveBeenCalledExactlyOnceWith('acp-restore');
    expect(drainSessionMessageOutbox).not.toHaveBeenCalled();
  });

});
