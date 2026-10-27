import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { LocalSessionRow } from '@shared/core/session-import/session-import';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@shared/core/projects/session-home-project';
import { SESSION_HOME_SECTION_KEY, displaySessionTitle } from '@shared/core/session-history/session-history';

/**
 * spec session-page「会话历史」(#6083)的合同,打在真 SQLite 上。
 *
 * 要证的是「三种会话合成一张表之后,筛 / 排 / 目录聚合由这里(主进程)做完再切页」——
 * 本机索引是分轮的,渲染侧对着半截索引排序会给出错的「最早 / 最晚」(票里的坑 ③),
 * 所以这一层的排序必须跨来源正确,且在切 limit 之前;目录行上的计数必须与展开看到的一致。
 */
const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  hasLocal: true,
  localRows: [] as LocalSessionRow[],
  list: vi.fn(),
  /** 假磁盘:目录 → 它所在 git 仓库的根(按前缀,worktree 可以映射到别处的主仓)。 */
  repoRoots: {} as Record<string, string>,
  remotes: {} as Record<string, string>,
  release: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/session-import/host-source', () => ({
  hasLocalSessionSource: () => mocks.hasLocal,
  getLocalSessionSource: () => ({ list: mocks.list }),
}));
vi.mock('@main/core/projects/operations/project-folders', () => ({ projectRootFolder: vi.fn() }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: { acquire: async () => ({
  value: { git: { openRepository: async (path: string) => ({
    value: { getRemotes: async () => ({ remotes: mocks.remotes[path] ? [{ name: 'origin', url: mocks.remotes[path] }] : [] }) },
    release: mocks.release,
  }) } }, release: mocks.release,
}) } }));

// 仓库根的真磁盘判法由 repo-root.test.ts 钉住;这里给一张假表,只测「按仓库归节」的规则。
vi.mock('./repo-root', () => ({
  findRepoRoot: (directory: string) => {
    const hit = Object.keys(mocks.repoRoots)
      .sort((a, b) => b.length - a.length)
      .find((prefix) => directory === prefix || directory.startsWith(`${prefix}/`));
    return hit ? mocks.repoRoots[hit] : null;
  },
}));

const { listSessionHistory, listSessionHistoryDirectories, toEpochMs } = await import('./list-session-history');
const { indexSessionsForApp } = await import('../extensions/app-sessions');

const T = (iso: string) => Date.parse(iso);

function local(overrides: Partial<LocalSessionRow> & { providerSessionId: string }): LocalSessionRow {
  return {
    engine: 'claude-code',
    title: overrides.providerSessionId,
    cwd: '/repo/sub',
    filePath: `/home/me/.claude/projects/x/${overrides.providerSessionId}.jsonl`,
    updatedAt: T('2026-09-10T00:00:00Z'),
    sizeBytes: 1,
    ...overrides,
  };
}

describe('listSessionHistory', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.hasLocal = true;
    mocks.list.mockReset();
    mocks.repoRoots = { '/repo': '/repo' };
    mocks.remotes = {};
    mocks.release.mockClear();
    mocks.list.mockImplementation(async () => ({
      rows: mocks.localRows,
      matched: mocks.localRows.length,
      discovered: mocks.localRows.length + 3,
      indexed: mocks.localRows.length,
      pending: 3,
      countsByEngine: { 'claude-code': 0, codex: 0 },
      stale: false,
    }));

    const sql = fixture.sqlite;
    sql.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'Repo', '/repo')`).run();
    sql.prepare(`INSERT INTO projects (id, name, path) VALUES ('p2', 'Other', '/other')`).run();
    const insert = sql.prepare(
      `INSERT INTO sessions (id, project_id, title, runtime, provider, provider_session_id, created_at, updated_at, last_interacted_at, archived_at, parent_session_id)
       VALUES (@id, @project, @title, 'acp', 'acp-prov', @providerSessionId, @createdAt, @updatedAt, @lastInteractedAt, @archivedAt, @parent)`
    );
    // 时间故意与插入顺序、字母顺序都不一致:三种排序若有一种退化成「按插入顺序」就会红。
    insert.run({ id: 'a', project: 'p1', title: 'Mango', providerSessionId: null, createdAt: '2026-09-01 00:00:00', updatedAt: '2026-09-05 00:00:00', lastInteractedAt: '2026-09-12T00:00:00.000Z', archivedAt: null, parent: null });
    insert.run({ id: 'b', project: 'p1', title: 'Apple', providerSessionId: null, createdAt: '2026-09-03 00:00:00', updatedAt: '2026-09-08 00:00:00', lastInteractedAt: null, archivedAt: '2026-09-09 00:00:00', parent: 'a' });
    insert.run({ id: 'c', project: 'p2', title: 'Kiwi', providerSessionId: 'sess-imported', createdAt: '2026-09-02 00:00:00', updatedAt: '2026-09-04 00:00:00', lastInteractedAt: null, archivedAt: null, parent: null });
    insert.run({ id: 'd', project: 'p1', title: 'Banana', providerSessionId: null, createdAt: '2026-09-04 00:00:00', updatedAt: '2026-09-06 00:00:00', lastInteractedAt: null, archivedAt: '2026-09-07 00:00:00', parent: null });

    mocks.localRows = [
      // 已经导入过(c 的 session_id 就是它)→ 不再算「未导入」。
      local({ providerSessionId: 'sess-imported', title: 'Kiwi on disk' }),
      local({ providerSessionId: 'L2', engine: 'codex', title: 'Zeta', cwd: '/repo/sub', updatedAt: T('2026-09-11T00:00:00Z') }),
      local({ providerSessionId: 'L3', title: 'Cherry', cwd: '/elsewhere', updatedAt: T('2026-09-02T00:00:00Z') }),
    ];
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const keys = (rows: Array<{ key: string }>) => rows.map((row) => row.key);

  it('三种会话合成一张表;已导入的本机会话由它的咕咕行代表,不再重复出现', async () => {
    const page = await listSessionHistory();
    expect(keys(page.rows)).toEqual([
      'local:/home/me/.claude/projects/x/L2.jsonl', // 09-11
      'gugu:b', // 09-08
      'gugu:d', // 09-06
      'gugu:a', // 09-05
      'gugu:c', // 09-04
      'local:/home/me/.claude/projects/x/L3.jsonl', // 09-02
    ]);
    expect(page.rows.some((row) => row.title === 'Kiwi on disk')).toBe(false);
    expect(page.countsBySource).toEqual({ gugu: 4, 'claude-code': 1, codex: 1 });
    expect(page.countsByStatus).toEqual({ active: 2, archived: 2, 'not-imported': 2 });
    // 索引进度原样透出(替身:3 条已索引、还有 3 条没读),❌ 因为去重少了一行就把 indexed 也减一。
    expect(page.local).toEqual({ discovered: 6, indexed: 3, pending: 3, stale: false });
    // 向索引要的是全量,❌ 切页:切了页,跨来源排序就只对被切到的那一截成立。
    expect(mocks.list.mock.calls[0][0]).toMatchObject({ limit: Number.MAX_SAFE_INTEGER });
  });

  it('排序跨来源生效,且在切 limit 之前', async () => {
    const byTitle = await listSessionHistory({ sort: 'title' });
    expect(byTitle.rows.map((row) => row.title)).toEqual(['Apple', 'Banana', 'Cherry', 'Kiwi', 'Mango', 'Zeta']);

    // 加入时间:本机行没有(还没导入),排最后;咕咕行按 created_at 倒序。
    const byAdded = await listSessionHistory({ sort: 'added' });
    expect(keys(byAdded.rows)).toEqual([
      'gugu:d', 'gugu:b', 'gugu:c', 'gugu:a',
      'local:/home/me/.claude/projects/x/L2.jsonl',
      'local:/home/me/.claude/projects/x/L3.jsonl',
    ]);

    // 最近提问:a 有一次 09-12 的提问,比所有行的更新时间都晚 ⇒ 必须排第一,虽然它的更新时间只排第四。
    const byPrompt = await listSessionHistory({ sort: 'lastPrompt' });
    expect(keys(byPrompt.rows)[0]).toBe('gugu:a');

    // limit 切的是排好序之后的头部:字母序前 2 条,而不是「最近更新的前 2 条再按字母排」。
    const limited = await listSessionHistory({ sort: 'title', limit: 2 });
    expect(limited.rows.map((row) => row.title)).toEqual(['Apple', 'Banana']);
    expect(limited.matched).toBe(6);
    // 第二页 = 排好序之后的第 3、4 条;matched 仍是全集。
    const second = await listSessionHistory({ sort: 'title', limit: 2, offset: 2 });
    expect(second.rows.map((row) => row.title)).toEqual(['Cherry', 'Kiwi']);
    expect(second.matched).toBe(6);
  });

  it('筛选:来源 / 状态 / 目录 / 时间范围 / 关键词', async () => {
    expect(keys((await listSessionHistory({ source: 'codex' })).rows)).toEqual(['local:/home/me/.claude/projects/x/L2.jsonl']);
    expect(keys((await listSessionHistory({ status: 'archived' })).rows)).toEqual(['gugu:b', 'gugu:d']);
    expect(keys((await listSessionHistory({ status: 'not-imported' })).rows)).toHaveLength(2);
    expect(keys((await listSessionHistory({ directory: '/elsewhere' })).rows)).toEqual(['local:/home/me/.claude/projects/x/L3.jsonl']);
    expect(keys((await listSessionHistory({ since: T('2026-09-07T00:00:00Z') })).rows)).toEqual([
      'local:/home/me/.claude/projects/x/L2.jsonl',
      'gugu:b',
    ]);
    // 关键词匹配标题、目录、项目名(项目名是咕咕行才有的,本机行没有)。
    expect(keys((await listSessionHistory({ query: 'other' })).rows)).toEqual(['gugu:c']);
    expect(keys((await listSessionHistory({ query: 'REPO sub' })).rows)).toEqual(['local:/home/me/.claude/projects/x/L2.jsonl']);
    // 阴性对照:一个谁也不匹配的词。
    expect((await listSessionHistory({ query: 'nothing-matches-this' })).rows).toEqual([]);
    // 候选 = 节(一个项目一节):Repo 项目四条(a b d + cwd 在 /repo/sub 的本机 L2),/other 一条,/elsewhere 一条。
    expect((await listSessionHistory()).directories[0]).toEqual({ directory: '/repo', projectName: 'Repo', count: 4 });
    // 候选跟着类型筛选走:只看咕咕会话时,只剩咕咕会话所在的节(/elsewhere 只有本机原件,不出现)。
    expect((await listSessionHistory({ source: 'gugu' })).directories.map((d) => d.directory)).toEqual(['/repo', '/other']);
    // 按节筛:给项目路径 = 这个项目下的全部(含子目录里的本机原件)。
    expect(keys((await listSessionHistory({ directory: '/repo' })).rows)).toContain('local:/home/me/.claude/projects/x/L2.jsonl');
  });

  it('关键词也匹配 session id / conversation id(设计同事 2026-09-23:「特色是支持基于 sessionid 的搜索」)', async () => {
    // 咕咕行:sessions.provider_session_id;本机行:原件 session id;都没有的按 conversation id。
    expect(keys((await listSessionHistory({ query: 'sess-imported' })).rows)).toEqual(['gugu:c']);
    expect(keys((await listSessionHistory({ query: 'L3' })).rows)).toEqual(['local:/home/me/.claude/projects/x/L3.jsonl']);
    expect(keys((await listSessionHistory({ query: 'b' })).rows)).toContain('gugu:b');
    const c = (await listSessionHistory()).rows.find((row) => row.key === 'gugu:c')!;
    expect(c.providerSessionId).toBe('sess-imported');
    expect(c.providerId).toBe('acp-prov');
    const l2 = (await listSessionHistory()).rows.find((row) => row.key === 'local:/home/me/.claude/projects/x/L2.jsonl')!;
    expect(l2.providerId).toBe('codex');
  });

  it('没有目录的会话:`directory: null` 只取它们,目录候选里也有它们一档', async () => {
    mocks.localRows = [...mocks.localRows, local({ providerSessionId: 'L4', title: 'Nowhere', cwd: null, updatedAt: T('2026-09-01T00:00:00Z') })];
    const page = await listSessionHistory({ directory: null });
    expect(keys(page.rows)).toEqual(['local:/home/me/.claude/projects/x/L4.jsonl']);
    expect(page.directories).toContainEqual({ directory: null, projectName: null, count: 1 });
    // 不给 directory = 全部,❌ 把 undefined 当成 null。
    expect((await listSessionHistory()).rows).toHaveLength(7);
  });

  it('目录视图:一个项目一节(子目录并进项目),计数与展开看到的一致;没有目录的拢成一节', async () => {
    mocks.localRows = [...mocks.localRows, local({ providerSessionId: 'L4', title: 'Nowhere', cwd: null, updatedAt: T('2026-09-01T00:00:00Z') })];
    const page = await listSessionHistoryDirectories();
    // 默认按「节里最近那条」倒序:Repo(含 /repo/sub 的 L2,09-11)→ /other 09-04 → /elsewhere 09-02 → 没有目录 09-01。
    expect(page.rows.map((row) => row.key)).toEqual(['/repo', '/other', '/elsewhere', '']);
    expect(page.matched).toBe(4);
    expect(page.countsBySource).toEqual({ gugu: 4, 'claude-code': 2, codex: 1 });

    const repo = page.rows[0];
    expect(repo).toMatchObject({
      directory: '/repo',
      projectName: 'Repo',
      sessionCount: 4,
      countsBySource: { gugu: 3, 'claude-code': 0, codex: 1 },
      countsByStatus: { active: 1, archived: 2, 'not-imported': 1 },
      updatedAt: T('2026-09-11T00:00:00Z'),
      lastPromptAt: T('2026-09-12T00:00:00.000Z'), // a 的提问比节里任何一条的更新时间都晚
      addedAt: toEpochMs('2026-09-04 00:00:00'),
      // 咕咕行的 provider 与本机 codex 行按引擎映射的 provider,按首次出现排。
      providers: ['acp-prov', 'codex'],
      sessions: [], // 没要每节的会话就不带
    });
    // 不在任何项目下的目录自成一节、没有项目名。
    expect(page.rows[2]).toMatchObject({ directory: '/elsewhere', projectName: null });
    expect(page.rows[3]).toMatchObject({ key: '', directory: null, projectName: null, sessionCount: 1 });

    // 目录行的计数 = 展开(同一套筛选 + directory)看到的条数。
    const expanded = await listSessionHistory({ directory: '/repo' });
    expect(expanded.matched).toBe(repo.sessionCount);

    // 每节随行带回头 N 条:按同一个 sort 排好再截(默认更新时间倒序 ⇒ L2 09-11、b 09-08),❌ 按插入顺序截。
    const withSessions = await listSessionHistoryDirectories({ sessionsPerDirectory: 2 });
    const repo2 = withSessions.rows.find((row) => row.key === '/repo')!;
    expect(keys(repo2.sessions)).toEqual(['local:/home/me/.claude/projects/x/L2.jsonl', 'gugu:b']);
    expect(repo2.sessionCount).toBe(4);
    const byTitle = await listSessionHistoryDirectories({ sort: 'title', sessionsPerDirectory: 1 });
    expect(keys(byTitle.rows.find((row) => row.key === '/repo')!.sessions)).toEqual(['gugu:b']); // Apple
  });

  it('一个项目一节:咕咕会话跑在项目路径之外的 worktree 里,也归它自己的项目那一节', async () => {
    const sql = fixture.sqlite;
    sql.prepare(`INSERT INTO workspaces (id, type, kind, path) VALUES ('w1', 'local', 'worktree', '/Users/me/.gugu/worktrees/repo-fix')`).run();
    sql.prepare(`UPDATE sessions SET workspace_id = 'w1' WHERE id = 'd'`).run();
    const d = (await listSessionHistory()).rows.find((row) => row.key === 'gugu:d')!;
    // 行自己的目录是 worktree(详情里如实写),节却是项目的。
    expect(d.directory).toBe('/Users/me/.gugu/worktrees/repo-fix');
    const page = await listSessionHistoryDirectories({ sessionsPerDirectory: 10 });
    expect(page.rows.map((row) => row.key)).toEqual(['/repo', '/other', '/elsewhere']);
    expect(keys(page.rows[0].sessions)).toContain('gugu:d');
    // 按节筛同样认项目:选「Repo」这一节看得到 worktree 里的那条。
    expect(keys((await listSessionHistory({ directory: '/repo' })).rows)).toContain('gugu:d');
  });

  it('本机原件按 git 仓库归节:同仓库的子目录、worktree 并成一节;不在仓库里的按目录本身', async () => {
    mocks.repoRoots = { '/repo': '/repo', '/wt/repo-fix': '/repo', '/code/tool': '/code/tool' };
    mocks.localRows = [
      local({ providerSessionId: 'W1', cwd: '/wt/repo-fix/pkg' }), // Repo 的 worktree ⇒ Repo 那一节
      local({ providerSessionId: 'T1', cwd: '/code/tool/src' }),
      local({ providerSessionId: 'T2', cwd: '/code/tool/docs' }), // 同一个仓库的两个子目录 ⇒ 一节
      local({ providerSessionId: 'S1', cwd: '/scratch/a' }),
      local({ providerSessionId: 'S2', cwd: '/scratch/b' }), // 不在仓库里 ⇒ 各自一节
    ];
    const page = await listSessionHistoryDirectories({ sessionsPerDirectory: 10 });
    const sections = Object.fromEntries(page.rows.map((row) => [row.key, keys(row.sessions)]));
    expect(sections['/repo']).toContain('local:/home/me/.claude/projects/x/W1.jsonl');
    expect(sections['/code/tool']).toEqual(
      expect.arrayContaining(['local:/home/me/.claude/projects/x/T1.jsonl', 'local:/home/me/.claude/projects/x/T2.jsonl'])
    );
    expect(page.rows.find((row) => row.key === '/code/tool')).toMatchObject({ projectName: null, sessionCount: 2 });
    expect(Object.keys(sections)).toEqual(expect.arrayContaining(['/scratch/a', '/scratch/b']));
    // 按节筛与节同一个口径:选 /code/tool 看得到两个子目录里的会话。
    expect((await listSessionHistory({ directory: '/code/tool' })).matched).toBe(2);
    expect((await indexSessionsForApp({})).rows.map(({ providerSessionId, group }) => ({ providerSessionId, group }))).toEqual([
      { providerSessionId: 'W1', group: { key: '/repo', label: null } },
      { providerSessionId: 'T1', group: { key: '/code/tool', label: null } },
      { providerSessionId: 'T2', group: { key: '/code/tool', label: null } },
      { providerSessionId: 'S1', group: { key: '/scratch/a', label: null } },
      { providerSessionId: 'S2', group: { key: '/scratch/b', label: null } },
    ]);
  });

  it('Apps group zero-task directories with history and canonicalize registered and native origins', async () => {
    fixture.sqlite.prepare(`INSERT INTO project_remotes (project_id, remote_name, remote_url) VALUES ('p1', 'origin', 'git@github.com:OpenDCAI/gugu.git')`).run();
    mocks.repoRoots = { '/repo': '/repo', '/wt/repo-fix': '/repo', '/tool': '/tool' };
    mocks.remotes = { '/tool': 'ssh://git@github.com/OpenDCAI/tools.git' };
    mocks.localRows = [local({ providerSessionId: 'W1', cwd: '/wt/repo-fix/pkg' }), local({ providerSessionId: 'M1', cwd: '/repo/pkg' })];
    const page = await indexSessionsForApp({ groupPaths: ['/tool/src', '/tool/docs', '/old-profile/task-home', '/scratch'] });
    expect(page.rows.map(({ group }) => group)).toEqual([
      { key: '/repo', label: null, repositoryUrl: 'https://github.com/OpenDCAI/gugu' },
      { key: '/repo', label: 'Repo', repositoryUrl: 'https://github.com/OpenDCAI/gugu' },
    ]);
    expect(page.groups).toEqual([
      { path: '/tool/src', group: { key: '/tool', label: null, repositoryUrl: 'https://github.com/OpenDCAI/tools' } },
      { path: '/tool/docs', group: { key: '/tool', label: null, repositoryUrl: 'https://github.com/OpenDCAI/tools' } },
      { path: '/old-profile/task-home', group: { key: SESSION_HOME_SECTION_KEY, label: null } },
      { path: '/scratch', group: { key: '/scratch', label: null } },
    ]);
    expect(mocks.release).toHaveBeenCalledTimes(2);
    await expect(indexSessionsForApp({ groupPaths: ['relative'] })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('咕咕项目不吞它仓库之外的原件:路径是 /Users 的项目只收 cwd 就是 /Users 的那条', async () => {
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p3', 'Users', '/Users')`).run();
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, runtime, provider, created_at, updated_at) VALUES ('u', 'p3', 'U', 'acp', 'acp-prov', '2026-09-01 00:00:00', '2026-09-01 00:00:00')`
      )
      .run();
    mocks.repoRoots = { '/repo': '/repo', '/Users/me/proj': '/Users/me/proj' };
    mocks.localRows = [
      local({ providerSessionId: 'P1', cwd: '/Users/me/proj/app' }), // 在自己的仓库里 ⇒ 仓库那一节
      local({ providerSessionId: 'X1', cwd: '/Users/me/scratch' }), // 不在仓库里 ⇒ 自己一节
      local({ providerSessionId: 'H1', cwd: '/Users' }), // 就在项目路径上 ⇒ 项目那一节
    ];
    const page = await listSessionHistoryDirectories({ sessionsPerDirectory: 10 });
    const users = page.rows.find((row) => row.key === '/Users')!;
    expect(keys(users.sessions)).toEqual(['local:/home/me/.claude/projects/x/H1.jsonl', 'gugu:u']);
    expect(page.rows.map((row) => row.key)).toEqual(expect.arrayContaining(['/Users/me/proj', '/Users/me/scratch']));
    expect((await indexSessionsForApp({})).rows.map(({ group }) => group)).toEqual([
      { key: '/Users/me/proj', label: null }, { key: '/Users/me/scratch', label: null }, { key: '/Users', label: 'Users' },
    ]);
    // 阴控:同一个 cwd 若就在 /Users 这个仓库里,它就该归项目 —— 证明上面没归进去是「仓库边界」的功劳,不是项目认不出。
    mocks.repoRoots = { '/repo': '/repo', '/Users': '/Users' };
    const inside = await listSessionHistoryDirectories({ sessionsPerDirectory: 10 });
    expect(inside.rows.find((row) => row.key === '/Users')!.sessionCount).toBe(4);
  });

  it('咕咕独立任务拢成一节:咕咕自己的独立任务 + cwd 落在任一咕咕实例 task-home 下的原件', async () => {
    const sql = fixture.sqlite;
    sql.prepare(`INSERT INTO projects (id, name, path) VALUES (?, 'Task home', '/Users/me/Library/gugu/task-home')`).run(IMPLICIT_SESSION_HOME_PROJECT_ID);
    sql
      .prepare(
        `INSERT INTO sessions (id, project_id, title, runtime, provider, created_at, updated_at) VALUES ('s', ?, 'S', 'acp', 'acp-prov', '2026-09-01 00:00:00', '2026-09-01 00:00:00')`
      )
      .run(IMPLICIT_SESSION_HOME_PROJECT_ID);
    mocks.localRows = [
      local({ providerSessionId: 'K1', cwd: '/Users/me/gugu-6386-profile/task-home' }), // 另一个咕咕实例的 task-home
      local({ providerSessionId: 'K2', cwd: 'C:\\Users\\me\\AppData\\Roaming\\gugu\\task-home\\sub' }), // Windows、在 task-home 之下
      local({ providerSessionId: 'N1', cwd: '/Users/me/task-homework' }), // 只是名字像 ⇒ 不算
    ];
    const page = await listSessionHistoryDirectories({ sessionsPerDirectory: 10 });
    const home = page.rows.find((row) => row.key === SESSION_HOME_SECTION_KEY)!;
    expect(keys(home.sessions).sort()).toEqual(
      ['gugu:s', 'local:/home/me/.claude/projects/x/K1.jsonl', 'local:/home/me/.claude/projects/x/K2.jsonl'].sort()
    );
    expect(home).toMatchObject({ directory: SESSION_HOME_SECTION_KEY, projectName: null });
    expect(page.rows.map((row) => row.key)).toContain('/Users/me/task-homework');
    // 咕咕自己的独立任务不再落进「未关联目录」。
    expect(page.rows.some((row) => row.key === '')).toBe(false);
    // 行自己的目录照旧是真 cwd(详情里如实写);按节筛认这一节。
    expect((await listSessionHistory()).rows.find((row) => row.key.endsWith('K1.jsonl'))!.directory).toBe('/Users/me/gugu-6386-profile/task-home');
    expect((await listSessionHistory({ directory: SESSION_HOME_SECTION_KEY })).matched).toBe(3);
    expect(page.directories).toContainEqual({ directory: SESSION_HOME_SECTION_KEY, projectName: null, count: 3 });
    expect((await indexSessionsForApp({})).rows.map(({ group }) => group)).toEqual([
      { key: SESSION_HOME_SECTION_KEY, label: null }, { key: SESSION_HOME_SECTION_KEY, label: null },
      { key: '/Users/me/task-homework', label: null },
    ]);
  });

  it('项目下拉的候选列出全部目录,不截成前几个', async () => {
    mocks.localRows = Array.from({ length: 40 }, (_, i) => local({ providerSessionId: `M${i}`, cwd: `/many/d${i}` }));
    const page = await listSessionHistory({ source: 'claude-code' });
    expect(page.directories).toHaveLength(40);
  });

  it('目录视图:「未关联目录」那一节永远排最后,即使它里面有最新的一条', async () => {
    mocks.localRows = [...mocks.localRows, local({ providerSessionId: 'L4', title: 'Nowhere', cwd: null, updatedAt: T('2026-09-20T00:00:00Z') })];
    expect((await listSessionHistoryDirectories()).rows.map((row) => row.key)).toEqual(['/repo', '/other', '/elsewhere', '']);
    expect((await listSessionHistoryDirectories({ sort: 'title' })).rows.map((row) => row.key).at(-1)).toBe('');
    // 平铺视图不受影响:最新的那条照样排第一。
    expect(keys((await listSessionHistory()).rows)[0]).toBe('local:/home/me/.claude/projects/x/L4.jsonl');
  });

  it('标题剥掉咕咕投递信封:行上是人话,只剩信封头的给空串(渲染层显示「无标题会话」)', async () => {
    mocks.localRows = [
      local({
        providerSessionId: 'L5',
        title:
          '<gugu_delivery route="chat" from="probe (咕咕号 1)" chat="9"> <message_context><![CDATA["@x" = user:1]]></message_context> <![CDATA[请只回复 OK]]> <arrival>Sent to you</arrival> </gugu_delivery>',
      }),
      local({ providerSessionId: 'L6', title: '<gugu_delivery route="chat" from="owner-play (咕咕号 108731)" fro' }),
    ];
    const rows = (await listSessionHistory({ source: 'claude-code' })).rows;
    expect(rows.map((row) => row.title).sort()).toEqual(['', '请只回复 OK']);
    // 普通标题原样(阴性对照:剥标签不能误伤没有标签的标题)。
    expect(displaySessionTitle('alpha 登录页 <主按钮')).toBe('alpha 登录页 <主按钮');
    expect(displaySessionTitle('a < b and c > d')).toBe('a < b and c > d');
  });

  it('目录视图:筛选先作用到会话再聚合;排序与切页作用在目录上', async () => {
    const archived = await listSessionHistoryDirectories({ status: 'archived' });
    expect(archived.rows.map((row) => [row.key, row.sessionCount])).toEqual([['/repo', 2]]);
    expect(archived.rows[0].countsByStatus).toEqual({ active: 0, archived: 2, 'not-imported': 0 });
    expect(keys((await listSessionHistoryDirectories({ query: 'zeta' })).rows)).toEqual(['/repo']);

    // 字母序按节的路径;第二页 = 排好序之后的第 3 节,matched 仍是全集。
    const byName = await listSessionHistoryDirectories({ sort: 'title' });
    expect(byName.rows.map((row) => row.key)).toEqual(['/elsewhere', '/other', '/repo']);
    const second = await listSessionHistoryDirectories({ sort: 'title', limit: 2, offset: 2 });
    expect(second.rows.map((row) => row.key)).toEqual(['/repo']);
    expect(second.matched).toBe(3);
  });

  it('父子范围说得出:挂在它下面的后代计数与「挂在谁下面」', async () => {
    const page = await listSessionHistory();
    const a = page.rows.find((row) => row.key === 'gugu:a')!;
    const b = page.rows.find((row) => row.key === 'gugu:b')!;
    expect(a.childCount).toBe(1);
    expect(a.parentTitle).toBeNull();
    expect(b.childCount).toBe(0);
    expect(b.parentTitle).toBe('Mango');
    expect(a.gugu).toEqual({ projectId: 'p1', sessionId: 'a', runtime: 'acp' });
    expect(b.archivedAt).toBe(toEpochMs('2026-09-09 00:00:00'));
  });

  it('宿主没接本机来源(web)时只有咕咕自己的会话,local 为 null', async () => {
    mocks.hasLocal = false;
    const page = await listSessionHistory();
    expect(page.local).toBeNull();
    expect(page.rows.every((row) => row.source === 'gugu')).toBe(true);
    expect(page.rows).toHaveLength(4);
    expect(mocks.list).not.toHaveBeenCalled();
    expect((await listSessionHistoryDirectories()).local).toBeNull();
  });
});

describe('toEpochMs', () => {
  it('认 SQLite 的 CURRENT_TIMESTAMP 与 ISO 串,认不出的给 null', () => {
    expect(toEpochMs('2026-09-09 00:00:00')).toBe(Date.parse('2026-09-09T00:00:00Z'));
    expect(toEpochMs('2026-09-12T00:00:00.000Z')).toBe(Date.parse('2026-09-12T00:00:00.000Z'));
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs('not a date')).toBeNull();
  });
});
