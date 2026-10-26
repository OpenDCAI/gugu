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
}));

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
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => undefined } }));
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

const { getProjects } = await import('../projects/operations/getProjects');
const { listSessionHistory } = await import('../session-history/list-session-history');
const { archiveSession, restoreSession } = await import('./archiveSession');
const { setOtherMachines } = await import('./session-family');
const { events } = await import('@main/lib/events');
const { sessionCreatedChannel } = await import('@shared/core/sessions/sessionEvents');

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
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
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
      setOtherMachines({ isThisDevice: async () => false, appSpawn: vi.fn(),
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
      setOtherMachines({ isThisDevice: async () => false, appSpawn: vi.fn(),
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
      setOtherMachines({ isThisDevice: async () => false, appSpawn: vi.fn(),
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
      setOtherMachines({ isThisDevice: async () => false, appSpawn: vi.fn(), sessions, archive: vi.fn(), appMessage, appReadFile, appCall });
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
});
