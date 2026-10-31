import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainSessionMessageOutbox } from './sendMessage';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';

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
}));

vi.mock('electron', () => ({ app: { getPath: () => mocks.userData }, clipboard: {}, nativeImage: {} }));
// Only the assistant ownership UI helper is replaced; close/delete/archive below are real.
vi.mock('@/lib/myAssistant', () => ({ isMyAssistant: () => false }));

vi.mock('./sendMessage', () => ({ drainSessionMessageOutbox: vi.fn(async () => undefined) }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
// 停 runtime 与收 tmux 不是这一层的命题:这里量的是「哪些行被动了」。
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
const { permanentlyDeleteAgentSession } = await import('./permanently-delete-agent-session');
const { setOtherMachines } = await import('./session-family');
const { events } = await import('@main/lib/events');
const { sessionCreatedChannel } = await import('@shared/core/sessions/sessionEvents');
const { sessionEvents } = await import('./session-events');

beforeEach(async () => { mocks.userData = await mkdtemp(join(tmpdir(), 'gugu-agent-delete-files-')); });
afterEach(async () => { await rm(mocks.userData, { recursive: true, force: true }); });

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
           (id, project_id, title, runtime, parent_session_id, spawned_by_session_id, config)
         VALUES (?, 'p1', ?, 'acp', ?, ?, ?)`
      )
      .run(
        id,
        id,
        opts.parent ?? null,
        opts.spawnedBy ?? null,
        opts.fork
          ? JSON.stringify({ version: 1, data: { forkedFrom: { sessionId: opts.fork, title: 'src' } } })
          : opts.remoteParent
            ? JSON.stringify({ version: '1', type: 'acp', parentRemote: { deviceId: 'dev-b', sessionId: opts.remoteParent } })
            : null
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
      INSERT INTO sessions (id, project_id, workspace_id, title, runtime, provider_session_id)
        VALUES ('historic-session', 'p1', 'historic-ws', 'history survives', 'acp', 'provider-original');
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
    expect(mocks.stopped).toEqual(['the-fork']);
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
    expect(mocks.stopped.sort()).toEqual(['child', 'grandchild', 'parent']);
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
    expect(mocks.stopped).toEqual([]);
  });

  it('已经归档过的会话再归档是空动作,不会二次停 runtime', async () => {
    insertSession('a');
    insertSession('b');
    await archiveSession('p1', 'a');
    mocks.stopped = [];

    await archiveSession('p1', 'a');

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

  const insert = (id: string) =>
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, runtime) VALUES (?, 'p1', ?, 'acp')`
      )
      .run(id, id);
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

  it('permanently removes only a deleted Agent task and its SQLite history; automatic archives stay restorable', async () => {
    vi.mocked(sessionEvents._emit).mockClear();
    insert('deleted-agent');
    insert('kept-agent');
    for (const id of ['deleted-agent', 'kept-agent']) {
      fixture.sqlite.prepare('INSERT INTO messages (id, session_id, content, sender) VALUES (?, ?, ?, ?)').run(`${id}:message`, id, 'history', 'user');
      fixture.sqlite.prepare('INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES (?, ?, 0, ?, ?)').run(`${id}:turn`, id, `${id}:provider-turn`, '[]');
      await archiveSession('p1', id);
    }
    expect(fixture.sqlite.prepare('SELECT id FROM messages ORDER BY id').all()).toHaveLength(2);
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns ORDER BY id').all()).toHaveLength(2);
    expect(sessionEvents._emit).not.toHaveBeenCalledWith('session:deleted', expect.any(String));
    await permanentlyDeleteAgentSession('deleted-agent');
    expect(sessionEvents._emit).toHaveBeenCalledWith('session:deleted', 'deleted-agent');
    expect(fixture.sqlite.prepare('SELECT id FROM sessions ORDER BY id').all()).toEqual([{ id: 'kept-agent' }]);
    expect(fixture.sqlite.prepare('SELECT id FROM messages ORDER BY id').all()).toEqual([{ id: 'kept-agent:message' }]);
    expect(fixture.sqlite.prepare('SELECT id FROM session_turns ORDER BY id').all()).toEqual([{ id: 'kept-agent:turn' }]);
    await expect(restoreSession('p1', 'deleted-agent')).rejects.toThrow('Session not found');
    await expect(permanentlyDeleteAgentSession('deleted-agent')).resolves.toBeUndefined();
    expect(vi.mocked(sessionEvents._emit).mock.calls.filter(([name]) => name === 'session:deleted')).toEqual([['session:deleted', 'deleted-agent']]);
    await expect(restoreSession('p1', 'kept-agent')).resolves.toMatchObject({ id: 'kept-agent', archivedAt: null });
  });

  it('does not leave a restorable task when stopping the deleted Agent fails', async () => {
    insert('stop-failed');
    mocks.mounted.add('stop-failed');
    mocks.teardown.mockRejectedValueOnce(new Error('runtime stop unavailable'));
    await expect(permanentlyDeleteAgentSession('stop-failed')).rejects.toThrow('runtime stop unavailable');
    expect(fixture.sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get('stop-failed')).toBeUndefined();
    await expect(restoreSession('p1', 'stop-failed')).rejects.toThrow('Session not found');
  });

  it('removes owned attachment files, non-FK history and saved UI/model state, keeping other tasks and user files', async () => {
    insert('purged');
    insert('untouched');
    const ownedDir = join(mocks.userData, 'task-attachments', 'purged');
    const legacyDir = join(mocks.userData, 'task-attachments', 'legacy-location');
    const keptDir = join(mocks.userData, 'task-attachments', 'untouched');
    await mkdir(ownedDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });
    await mkdir(keptDir, { recursive: true });
    const owned = join(ownedDir, 'copy.txt');
    const legacy = join(legacyDir, 'legacy.txt');
    const userFile = join(mocks.userData, 'user-original.txt');
    const keptCopy = join(keptDir, 'kept.txt');
    for (const file of [owned, legacy, userFile, keptCopy]) await writeFile(file, 'retained unless owned by the deleted task');
    for (const [id, origin, path] of [['copy', 'copy', owned], ['legacy', 'copy', legacy], ['reference', 'reference', userFile]]) {
      fixture.sqlite.prepare('INSERT INTO session_attachments (id, session_id, name, size, stored_path, origin) VALUES (?, ?, ?, 1, ?, ?)').run(id, 'purged', id, path, origin);
    }
    fixture.sqlite.prepare("INSERT INTO session_attachments (id, session_id, name, size, stored_path, origin) VALUES ('untouched-copy', 'untouched', 'kept.txt', 1, ?, 'copy')").run(keptCopy);
    for (const id of ['purged', 'untouched']) {
      fixture.sqlite.prepare("INSERT INTO activity_events (event_id, observed_at, kind, session_id, data) VALUES (?, 1, 'session.created', ?, '{}')").run(id, id);
      fixture.sqlite.prepare('INSERT INTO session_run_intervals (session_id, started_at, last_seen_at) VALUES (?, 1, 2)').run(id);
      fixture.sqlite.prepare("INSERT INTO session_model_sources (session_id, source, started_at) VALUES (?, 'gugu', 1)").run(id);
      fixture.sqlite.prepare("INSERT OR REPLACE INTO activity_session_projects (session_id, project_id) VALUES (?, 'p1')").run(id);
    }
    const { viewStateService } = await import('../view-state/view-state-service');
    const { recordSessionPlatformModel, sessionPlatformModel } = await import('./platform-model-selection');
    const { recordSessionOutput, sessionOutputs } = await import('./session-outputs');
    await viewStateService.save('session:purged', { open: true });
    await viewStateService.save('session:purged:tabs', ['history']);
    await recordSessionPlatformModel('purged', { modelId: 'original-model' });
    await recordSessionOutput('purged', { kind: 'file', path: userFile });
    await permanentlyDeleteAgentSession('purged');
    expect(existsSync(ownedDir)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(userFile)).toBe(true);
    expect(existsSync(keptCopy)).toBe(true);
    for (const table of ['activity_events', 'session_run_intervals', 'session_model_sources', 'activity_session_projects']) {
      expect(fixture.sqlite.prepare(`SELECT session_id FROM ${table}`).all()).toEqual([{ session_id: 'untouched' }]);
    }
    expect(fixture.sqlite.prepare('SELECT id FROM session_attachments').all()).toEqual([{ id: 'untouched-copy' }]);
    expect(await viewStateService.get('session:purged')).toBeNull();
    expect(await viewStateService.get('session:purged:tabs')).toBeNull();
    expect(await sessionPlatformModel('purged')).toBeUndefined();
    expect(await sessionOutputs('purged')).toEqual([]);
    expect(fixture.sqlite.prepare("SELECT key FROM kv WHERE key = 'session-archival:purged'").get()).toBeUndefined();
  });

  it('serializes permanent deletion with a Restore queued while runtime teardown is pending', async () => {
    insert('delete-race');
    mocks.mounted.add('delete-race');
    const stopping = Promise.withResolvers<{ success: boolean }>();
    mocks.teardown.mockReturnValueOnce(stopping.promise);
    const deleting = permanentlyDeleteAgentSession('delete-race');
    await vi.waitFor(() => expect(mocks.teardown).toHaveBeenCalledWith('delete-race', 'archive'));
    let restoreSettled = false;
    const restoring = restoreSession('p1', 'delete-race').then(
      () => { restoreSettled = true; return 'restored'; },
      (error: Error) => { restoreSettled = true; return error.message; },
    );
    await Promise.resolve();
    expect(restoreSettled).toBe(false);
    stopping.resolve({ success: true });
    await deleting;
    expect(await restoring).toContain('Session not found');
    expect(fixture.sqlite.prepare('SELECT id FROM sessions').all()).toEqual([]);
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
    const { releaseDeletedOwnedAgent } = await import('../../../../sessionpage/owner-agent-deletion');
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
    const deletedIdentities: string[] = [];
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
          deletedIdentities.push(agentId); // The cloud identity RPC boundary alone is injected.
          const { sessionpageSessionIdForAgent, releaseAgentLocalFootprint } = await import('../../../../sessionpage/agent-local-footprint');
          await releaseDeletedOwnedAgent(agentId, {
            sessionIdForAgent: id => sessionpageSessionIdForAgent(id, env),
            cancelInFlightTurn: async () => false,
            releaseFootprint: id => releaseAgentLocalFootprint({ agentUserId: id, identityRemoved: true, env }),
            removeBoundSession: permanentlyDeleteAgentSession,
          });
        },
        archiveSession: async (projectId, sessionId) => { await archiveSession(projectId, sessionId); },
        wipeHome, resetLocalState,
      });
      expect(wipeHome).toHaveBeenCalledOnce();
      expect(resetLocalState).toHaveBeenCalledOnce();
      expect(deletedIdentities).toEqual(deleteStarted ? ['child-id', 'assistant-id'] : ['assistant-id']);
      const history = await listSessionHistory({ source: 'gugu', status: 'archived' });
      expect(history.rows.map(row => row.gugu?.sessionId).sort()).toEqual(deleteStarted ? ['assistant-unbound'] : ['assistant-unbound', 'started-task']);
      expect(archivedAt('assistant-unbound')).not.toBeNull();
      await expect(restoreSession('p1', 'assistant-task')).rejects.toThrow('Session not found');
      expect(await getAutomation(schedules.get('assistant-task')!)).toBeNull();
      expect(await getAutomation(schedules.get('assistant-unbound')!)).toBeNull();
      expect(await getAutomation(schedules.get('other-task')!)).toMatchObject({ agentSessionId: 'other-task', enabled: true });
      if (deleteStarted) {
        expect(await getAutomation(startedSchedule)).toBeNull();
        await expect(restoreSession('p1', 'started-task')).rejects.toThrow('Session not found');
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
  it('drains only the restored task once after releasing its archival lock', async () => {
    insert('restore-owner'); insert('other-owner');
    await archiveSession('p1', 'restore-owner');
    vi.mocked(drainSessionMessageOutbox).mockClear();
    vi.mocked(drainSessionMessageOutbox).mockImplementationOnce(async () => {
      const { serializeSessionArchival } = await import('./session-archival');
      await serializeSessionArchival('restore-owner', async () => undefined);
    });
    await restoreSession('p1', 'restore-owner');
    expect(drainSessionMessageOutbox).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', sessionId: 'restore-owner' });
  });

});
