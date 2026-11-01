// 导入本机会话：落点解析与会话绑定。
// 关心的是「导入进来的会话是不是原来那条」——绑错 id 就会开出一个空会话，而界面上看不出来。
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  createSession: vi.fn(),
  createLocalProject: vi.fn(),
  ensureRepositoryWorkspace: vi.fn(() => 'workspace-repo-1'),
  openProject: vi.fn(),
  preview: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/sessions/session-service', () => ({
  sessionService: { createSession: mocks.createSession },
}));
vi.mock('@main/core/projects/operations/create-local-project', () => ({
  createLocalProject: mocks.createLocalProject,
}));
vi.mock('@main/core/projects/operations/ensure-repository-workspace', () => ({
  ensureRepositoryWorkspace: mocks.ensureRepositoryWorkspace,
}));
vi.mock('@main/core/projects/operations/openProject', () => ({
  openProject: mocks.openProject,
}));
vi.mock('./host-source', () => ({
  getLocalSessionSource: () => ({ preview: mocks.preview }),
}));

import { importLocalSession } from './import-local-session';

const CLAUDE_SESSION = '11111111-2222-3333-4444-555555555555';
const CODEX_SESSION = '019fa62b-9ddb-7373-a1b8-807548106894';

function previewOf(overrides: Partial<{ providerSessionId: string; cwd: string | null; title: string }>) {
  return {
    providerSessionId: overrides.providerSessionId ?? CLAUDE_SESSION,
    title: overrides.title ?? '把登录页按钮改成设计稿的颜色',
    cwd: overrides.cwd === undefined ? '/work/webapp' : overrides.cwd,
    turnCount: 12,
    head: [],
    tail: [],
  };
}

function lastCreateSessionParams(): CreateSessionParams {
  return mocks.createSession.mock.calls.at(-1)?.[0] as CreateSessionParams;
}

/**
 * 导入是**另一个动词**(spec session-resume):provider 自己的会话 id 挂在 origin 上,
 * 而不是「新建时顺手多带一个字段」—— 后者曾经让「导入」与「新建」共用同一条路。
 */
function importedProviderSessionId(params: CreateSessionParams): string | undefined {
  const origin = params.sessionConfig.initialSession?.origin;
  return origin?.kind === 'import' ? origin.providerSessionId : undefined;
}

describe('importLocalSession', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.createSession.mockReset();
    mocks.createSession.mockResolvedValue({ success: true, data: {} });
    mocks.createLocalProject.mockReset();
    mocks.createLocalProject.mockResolvedValue({
      success: true,
      data: {
        type: 'local',
        id: 'project-new',
        name: 'webapp',
        path: '/work/webapp',
        baseRef: null,
        repositoryWorkspaceId: 'workspace-repo-1',
        createdAt: '',
        updatedAt: '',
      },
    });
    mocks.openProject.mockReset();
    mocks.openProject.mockResolvedValue({ success: true, data: { repositoryWorkspaceId: null } });
    mocks.preview.mockReset();
    mocks.preview.mockResolvedValue(previewOf({}));
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  describe('会话绑定', () => {
    it('claude 会话用原会话 id 当 conversation id（claude CLI 就是拿它 resume 的）', async () => {
      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/home/u/.claude/projects/-work-webapp/session.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.sessionId).toBe(CLAUDE_SESSION);
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
    });

    it('codex 会话把原会话 id 放在 sessionId 上，conversation id 另取（codex 靠 sessionId resume）', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CODEX_SESSION }));

      const result = await importLocalSession({
        engine: 'codex',
        providerSessionId: CODEX_SESSION,
        filePath: '/home/u/.codex/sessions/2026/07/30/rollout-x.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.sessionId).not.toBe(CODEX_SESSION);
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CODEX_SESSION);
    });

    it('默认和显式通用都进聊天腿,显式终端照常走终端腿,续的仍是原会话 id', async () => {
      const params = {
        engine: 'claude-code' as const,
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      };
      await importLocalSession(params);
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('acp');

      await importLocalSession({ ...params, sessionView: 'general' });
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('acp');
      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
      await importLocalSession({ ...params, sessionView: 'code' });
      expect(lastCreateSessionParams().sessionConfig.initialSession?.type).toBe('pty');
    });

    it('provider 按引擎映射到会话页的 agent id', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(lastCreateSessionParams().sessionConfig.initialSession?.provider).toBe('claude');
    });

    it('以原件里的会话 id 为准，不信渲染层传来的那个', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: CLAUDE_SESSION }));

      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: '渲染层传来的过期 id',
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(importedProviderSessionId(lastCreateSessionParams())).toBe(CLAUDE_SESSION);
    });
  });

  describe('落点', () => {
    it('会话跑在原来的工作目录，不另开 worktree', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(lastCreateSessionParams().workspaceConfig).toMatchObject({
        workspace: { kind: 'repository-instance', workspaceId: 'workspace-repo-1' },
      });
    });

    it('这个目录已经是某个项目时直接用它，不再建一个', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path, repository_workspace_id)
          VALUES ('project-existing', 'webapp', '/work/webapp', 'workspace-existing');
      `);

      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result.projectId).toBe('project-existing');
      expect(mocks.createLocalProject).not.toHaveBeenCalled();
    });

    it('目录不是仓库根时按原目录建项目（不归一化到仓库根，否则 resume 找不到原会话）', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.createLocalProject).toHaveBeenCalledWith(
        expect.objectContaining({ path: '/work/webapp', exactPath: true })
      );
    });

    it('目录还不是项目时把它加成项目，且放行非 git 目录', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.createLocalProject).toHaveBeenCalledWith(
        // #609 导入是替人登记的:在 ~ 里跑的会话导进来是 workspace,❌ 多出一个「~」项目。
        expect.objectContaining({ path: '/work/webapp', allowNonGit: true, reuseExisting: true, automatic: true })
      );
    });
  });

  // 真机实测抓到的：项目在库里建出来了，但没挂进 projectManager，建任务就报 project-not-found
  // ——一个指向错误方向的报错（项目明明在）。复用既有项目那条路尤其致命：重试永远走它，永久失败。
  describe('落点项目必须挂载', () => {
    it('新建的项目要挂载', async () => {
      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.openProject).toHaveBeenCalledWith('project-new');
    });

    it('复用已存在的项目时同样要挂载（否则重试永远失败）', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path, repository_workspace_id)
          VALUES ('project-existing', 'webapp', '/work/webapp', 'workspace-existing');
      `);

      await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(mocks.openProject).toHaveBeenCalledWith('project-existing');
      expect(mocks.createLocalProject).not.toHaveBeenCalled();
    });

    it('挂不上就报出真实原因并停下，不留一个建不了任务的项目', async () => {
      mocks.openProject.mockResolvedValue({
        success: false,
        error: { type: 'error', message: 'git rev-parse --show-toplevel failed (exit 128)' },
      });

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: '/work/webapp',
        })
      ).rejects.toThrow('rev-parse');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });
  });

  describe('重复导入', () => {
    it('同一条会话再导入一次就回到已有的那个，不建第二个', async () => {
      fixture.sqlite.exec(`
        INSERT INTO projects (id, name, path) VALUES ('project-1', 'webapp', '/work/webapp');
        INSERT INTO sessions (id, project_id, provider, runtime, provider_session_id)
          VALUES ('conv-1', 'project-1', 'claude', 'pty', '${CLAUDE_SESSION}');
      `);

      const result = await importLocalSession({
        engine: 'claude-code',
        providerSessionId: CLAUDE_SESSION,
        filePath: '/f.jsonl',
        title: '标题',
        cwd: '/work/webapp',
      });

      expect(result).toMatchObject({
        alreadyImported: true,
        sessionId: 'conv-1',
        projectId: 'project-1',
      });
      expect(mocks.createSession).not.toHaveBeenCalled();
    });
  });

  describe('读不出来就报错停', () => {
    it('原件里没有工作目录 → 明确报错，不落到别的目录去跑', async () => {
      mocks.preview.mockResolvedValue(previewOf({ cwd: null }));

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: null,
        })
      ).rejects.toThrow('工作目录');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('原件里没有会话 id → 明确报错，不建一个恢复不了的空会话', async () => {
      mocks.preview.mockResolvedValue(previewOf({ providerSessionId: '  ' }));

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: '/work/webapp',
        })
      ).rejects.toThrow('会话 id');
      expect(mocks.createSession).not.toHaveBeenCalled();
    });

    it('建任务失败就把错误抛出去，不假装导入成功', async () => {
      mocks.createSession.mockResolvedValue({ success: false, error: { type: 'project-not-found' } });

      await expect(
        importLocalSession({
          engine: 'claude-code',
          providerSessionId: CLAUDE_SESSION,
          filePath: '/f.jsonl',
          title: '标题',
          cwd: '/work/webapp',
        })
      ).rejects.toThrow('project-not-found');
    });
  });
});
