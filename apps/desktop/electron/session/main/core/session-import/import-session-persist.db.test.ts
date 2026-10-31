// 导入的会话到底有没有「带着原会话 id」落进库里 —— 用真 createSession 写真 SQLite 验。
// 单独一支：import-local-session.db.test.ts 把 sessionService 整个 mock 了，验的是「请求对不对」；
// 这里验「库里躺着的那一行对不对」。provider_session_id 是 hydrate 时判定「首次启动 vs resume」的唯一依据，
// 写不进去 = 导入的会话开起来是全新的，而界面上完全看不出来。
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: () => ({ id: 'project-1' }) },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
// @@@5173 createSession 现在会先问「这台机器上这个引擎此刻起得来吗」。本文件验的是落库语义,
// 不是引擎可用性(那条在 resolve-agent-executable.test.ts / createSession.test.ts) ——
// 这里显式声明「引擎可用」,否则跑测试的机器上装没装 codex 会决定这几条用例的红绿。
vi.mock('@main/core/sessions/impl/harness-availability', () => ({
  checkLocalHarnessAvailable: vi.fn(async () => null),
}));

import { createSession } from '@main/core/sessions/operations/createSession';
import { setTaskNamer } from '../sessions/task-name';

// Sessions are named at creation by the host's namer (task-name.ts); number defaults per provider.
beforeEach(() => setTaskNamer({ defaultName: async (provider, taken) => `${provider} ${taken.length + 1}` }));
afterEach(() => setTaskNamer(null));

const NATIVE_SESSION_ID = '019fa62b-9ddb-7373-a1b8-807548106894';

describe('导入的会话落库', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    // 会话落在项目的根目录(导入走 repo-root 预设,拿的就是 projects.repository_workspace_id)。
    // #7341 起 createSession 会核对这个工作区是不是这个项目的文件夹 —— 种子得像真库那样连上。
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('project-1', 'webapp', '/work/webapp', 'ws-repo-1');
      INSERT INTO workspaces (id, kind, location, type) VALUES ('ws-repo-1', 'project-root', 'local', 'local');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('conversation 行带着 provider 的原会话 id（下次启动据此 resume）', async () => {
    await createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: '导入的会话',
        initialSession: {
          id: 'conv-1',
          provider: 'codex',
          origin: { kind: 'import', providerSessionId: NATIVE_SESSION_ID },
          title: '导入的会话',
          type: 'pty',
        },
      },
      workspaceConfig: {
        version: '2',
        workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
      },
    });

    const row = fixture.sqlite
      .prepare('SELECT id, provider_session_id, provider, runtime FROM sessions WHERE id = ?')
      .get('conv-1');
    expect(row).toEqual({
      id: 'conv-1',
      provider_session_id: NATIVE_SESSION_ID,
      provider: 'codex',
      runtime: 'pty',
    });
  });

  it('正常创建的会话 provider_session_id 为空（保持「首次启动 = 全新会话」）', async () => {
    await createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: '普通任务',
        initialSession: {
          id: 'conv-2',
          provider: 'codex',
          title: '普通任务',
          origin: { kind: 'create', firstUtterance: '开工' },
        },
      },
      workspaceConfig: {
        version: '2',
        workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
      },
    });

    const row = fixture.sqlite
      .prepare('SELECT provider_session_id FROM sessions WHERE id = ?')
      .get('conv-2') as { provider_session_id: string | null };
    expect(row.provider_session_id).toBeNull();
  });

  // @@@5173 导入不受「引擎此刻起不起得来」约束:历史在引擎那边,认领它不启动任何会话。
  // 这条守着那个豁免 —— 去掉它,引擎装在别处或正在升级就会变成「导入不了历史」,
  // 而那是一条谁都没要求过的新限制。
  it('引擎起不来也照样导得进来（导入不是「新建」）', async () => {
    const { checkLocalHarnessAvailable } = await import(
      '@main/core/sessions/impl/harness-availability'
    );
    // 上面那条「正常创建」已经问过一次闸,计数会带过来 —— 不清掉,下面那条断言测的就不是这条用例。
    vi.mocked(checkLocalHarnessAvailable).mockClear();
    // 陷阱:万一哪天导入又被纳进这道闸,这个答案会让 createSession 失败,下面的落库断言当场转红。
    vi.mocked(checkLocalHarnessAvailable).mockResolvedValueOnce({
      reason: 'updating',
      providerId: 'codex',
      harnessName: 'codex',
      detail: 'codex is updating: …',
    });

    await createSession({
      projectId: 'project-1',
      sessionConfig: {
        version: '1',
        name: '导入的会话',
        initialSession: {
          id: 'conv-3',
          provider: 'codex',
          title: '导入的会话',
          origin: { kind: 'import', providerSessionId: NATIVE_SESSION_ID },
        },
      },
      workspaceConfig: {
        version: '2',
        workspace: { kind: 'repository-instance', workspaceId: 'ws-repo-1' },
      },
    });

    const row = fixture.sqlite
      .prepare('SELECT provider_session_id FROM sessions WHERE id = ?')
      .get('conv-3') as { provider_session_id: string | null } | undefined;
    expect(row?.provider_session_id).toBe(NATIVE_SESSION_ID);
    // 导入这条路**根本没走到**那道闸 —— 不是走到了然后被放行。两者的区别在于:
    // 后者会让「引擎不可用」的答案有机会影响导入,而这条用例要守的正是它影响不到。
    expect(checkLocalHarnessAvailable).not.toHaveBeenCalled();
  });
});
