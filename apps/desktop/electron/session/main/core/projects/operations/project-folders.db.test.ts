// #7341 项目挂的文件夹,打在真 SQLite 与真目录上:一个文件夹只属于一个项目、挂两次不出两行、摘下不删行。
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { createLocalProject } from './create-local-project';
import { getProjectById, getProjects } from './getProjects';
import { runProjectAgentAction } from '../project-agent-actions';
import { setProjectGroupHost } from '../project-group-host';
import { onActivitySignal } from '../../activity/signals';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emitted: [] as { name: string; data: unknown }[],
  branches: new Map<string, string>(),
  opened: vi.fn(),
  created: vi.fn(),
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { openProject: mocks.opened },
}));
vi.mock('@main/core/projects/project-events', () => ({
  projectEvents: { _emit: mocks.created },
}));
vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: async () => ({
      value: {
        files: {
          path: { isAbsolute: (value: string) => value.startsWith('/') },
          fileSystem: () => ({ success: true, data: { stat: async (value: string) => ({ success: true, data: { path: value, type: 'directory' } }) } }),
        },
        git: { inspectPath: async () => ({ kind: 'not-repository' }) },
      },
      release: async () => {},
    }),
  },
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({
  events: {
    emit: (event: { name: string }, data: unknown) => mocks.emitted.push({ name: event.name, data }),
  },
}));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log };
});
// 分支读法本身在 read-folder-branch.test.ts 里用真 git 测;这里只看它读到的值有没有落到对的那张卡上。
vi.mock('./read-folder-branch', () => ({
  readFolderBranch: async (folderPath: string) => mocks.branches.get(folderPath) ?? null,
}));

import {
  attachProjectFolder,
  detachProjectFolder,
  getProjectOwningAttachedFolder,
  listProjectFolders,
  resolveProjectFolder,
} from './project-folders';

const FOLDERS_CHANGED = 'project:folders-changed';

describe('project folders', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let tmp: string;
  let rootA: string;
  let rootB: string;
  let worktree: string;
  let related: string;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emitted.length = 0;
    mocks.branches.clear();
    mocks.opened.mockReset().mockResolvedValue({ success: true, data: {} });
    mocks.created.mockReset();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'gugu-project-folders-'));
    rootA = path.join(tmp, 'gugu');
    rootB = path.join(tmp, 'other');
    worktree = path.join(tmp, 'gugu-7341');
    related = path.join(tmp, 'gugu-supabase');
    for (const dir of [rootA, rootB, worktree, related]) await mkdir(dir);
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-a', 'project-root', 'local', 'local', '${rootA}', '${computeWorkspaceKey(rootA)}');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-b', 'project-root', 'local', 'local', '${rootB}', '${computeWorkspaceKey(rootB)}');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('project-a', 'gugu', '${rootA}', 'ws-root-a');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('project-b', 'other', '${rootB}', 'ws-root-b');
    `);
  });

  afterEach(async () => {
    vi.useRealTimers();
    setProjectGroupHost(null);
    fixture.close();
    mocks.db = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it('records real folder membership changes once, excluding repeats and refusals', async () => {
    const activity: { kind: string; object_id?: string; related_object_id?: string }[] = [];
    const off = onActivitySignal(event => activity.push(event));
    try {
      const attached = await attachOk('project-a', related);
      await attachOk('project-a', related);
      expect((await attachProjectFolder('missing', related)).success).toBe(false);
      await detachProjectFolder('project-a', attached.workspaceId);
      expect((await detachProjectFolder('project-a', attached.workspaceId)).success).toBe(false);
      expect(activity.map(event => [event.kind, event.object_id, event.related_object_id])).toEqual([
        ['project.folder_attached', 'project-a', attached.workspaceId],
        ['project.folder_detached', 'project-a', attached.workspaceId],
      ]);
    } finally { off(); }
  });

  it('MCP 把本机另一个项目根目录接进来时先确认,共享群后原目录与会话仍在,撤销可恢复', async () => {
    const groups = new Map([['project-a', 'chat-a'], ['project-b', 'chat-b']]);
    setProjectGroupHost({
      listBindings: async (ids) => ({ success: true, data: ids.flatMap((projectId) => {
        const chatId = groups.get(projectId);
        return chatId ? [{ projectId, chatId }] : [];
      }) }),
      ensureGroup: async ({ projectId }) => ({ success: true, data: { chatId: groups.get(projectId)!, changed: false } }),
      bindToGroup: async ({ projectId }, chatId, expectedChatId) => {
        const previousChatId = groups.get(projectId) ?? null;
        expect(previousChatId).toBe(expectedChatId);
        groups.set(projectId, chatId);
        return { success: true, data: { movedAgents: 1, previousChatId, changed: true } };
      },
      unbind: async ({ projectId }) => {
        groups.delete(projectId);
        return { success: true, data: { changed: true, expectedChatId: null } };
      },
    });
    await writeFile(path.join(rootB, 'keep.txt'), 'original');
    fixture.sqlite.exec("INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('source-session', 'project-b', 'ws-root-b', 'keep')");

    const pending = await runProjectAgentAction({ projectId: 'project-a' }, { action: 'project_add_folder', path: rootB }) as { needs_confirmation: boolean; source_project_id: string; sessions: number };
    expect(pending).toMatchObject({ needs_confirmation: true, source_project_id: 'project-b', sessions: 1 });
    expect(groups.get('project-b')).toBe('chat-b');
    expect(workspaceRow('ws-root-b')?.project_id).toBeNull();

    const joined = await runProjectAgentAction({ projectId: 'project-a' }, {
      action: 'project_add_folder', path: rootB, merge_existing: true, source_project_id: pending.source_project_id,
    }) as { undo: { tool: 'project_restore_device'; project_id: string; chat_id: string; expected_chat_id: string } };
    expect(groups.get('project-b')).toBe('chat-a');
    expect(joined.undo).toEqual({ tool: 'project_restore_device', project_id: 'project-b', chat_id: 'chat-b', expected_chat_id: 'chat-a' });
    expect((await listProjectFolders('project-b')).success).toBe(true);
    expect((fixture.sqlite.prepare("SELECT project_id FROM sessions WHERE id = 'source-session'").get() as { project_id: string }).project_id).toBe('project-b');
    expect(await readFile(path.join(rootB, 'keep.txt'), 'utf8')).toBe('original');

    await runProjectAgentAction({}, { action: joined.undo.tool, project_id: joined.undo.project_id, chat_id: joined.undo.chat_id, expected_chat_id: joined.undo.expected_chat_id });
    expect(groups.get('project-b')).toBe('chat-b');
  });

  /** 挂上的时间来自时钟:钉住它,先后与「是这一次挂的」才判得出来。 */
  function at(iso: string) {
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  }

  function workspaceRow(id: string) {
    return fixture.sqlite
      .prepare('SELECT id, kind, path, project_id, attached_at FROM workspaces WHERE id = ?')
      .get(id) as { id: string; kind: string; path: string; project_id: string | null; attached_at: string | null } | undefined;
  }

  function workspaceCount(): number {
    return (fixture.sqlite.prepare('SELECT count(*) AS n FROM workspaces').get() as { n: number }).n;
  }

  async function attachOk(projectId: string, folder: string) {
    const result = await attachProjectFolder(projectId, folder);
    if (!result.success) throw new Error(`attach failed: ${JSON.stringify(result.error)}`);
    return result.data;
  }

  describe('project creation', () => {
    it('creates the real directory and root record before publishing a successful project', async () => {
      const folderPath = path.join(tmp, 'new-project');
      const result = await createLocalProject({
        id: 'new-project', name: 'New project', path: folderPath, createDirectory: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) throw new Error(JSON.stringify(result.error));
      expect(result.data.repositoryWorkspaceId).toEqual(expect.any(String));
      const listed = await listProjectFolders(result.data.id);
      expect(listed).toMatchObject({ success: true, data: [{
        workspaceId: result.data.repositoryWorkspaceId, kind: 'root', path: folderPath,
      }] });
      expect(mocks.opened).toHaveBeenCalledWith(expect.objectContaining({
        repositoryWorkspaceId: result.data.repositoryWorkspaceId,
      }));
      expect(mocks.created).toHaveBeenCalledWith('project:created', result.data);
    });

    it('rolls back the project when its root cannot be registered and preserves the directory and files', async () => {
      await writeFile(path.join(related, 'notes.txt'), 'keep my files');
      fixture.sqlite.exec(`CREATE TRIGGER refuse_new_root BEFORE INSERT ON workspaces
        WHEN NEW.kind = 'project-root' BEGIN SELECT RAISE(ABORT, 'root registration failed'); END;`);
      const result = await createLocalProject({
        id: 'failed-project', name: 'Failed project', path: related, exactPath: true,
      });
      expect(result).toMatchObject({ success: false, error: { type: 'init-failed', message: 'root registration failed' } });
      expect(fixture.sqlite.prepare('SELECT id FROM projects WHERE id = ?').get('failed-project')).toBeUndefined();
      expect(workspaceCount()).toBe(2);
      expect(mocks.opened).not.toHaveBeenCalled();
      expect(mocks.created).not.toHaveBeenCalled();
      expect(await readFile(path.join(related, 'notes.txt'), 'utf8')).toBe('keep my files');
    });
  });

  describe('listProjectFolders', () => {
    it('根目录在前,挂上的按挂上的先后;会话只数本项目没归档的;分支落在各自的卡上', async () => {
      mocks.branches.set(rootA, 'dev');
      mocks.branches.set(worktree, 'feat/7341-project-folders');
      // 先挂的 related 排在前面 —— 挂上的先后,不是路径的字母序(gugu-7341 < gugu-supabase),也不是随机 id
      at('2026-10-16T01:00:00.000Z');
      const relatedFolder = await attachOk('project-a', related);
      at('2026-10-16T02:00:00.000Z');
      const worktreeFolder = await attachOk('project-a', worktree);
      vi.useRealTimers();
      expect([relatedFolder.attachedAt, worktreeFolder.attachedAt]).toEqual(['2026-10-16T01:00:00.000Z', '2026-10-16T02:00:00.000Z']);
      fixture.sqlite.exec(`
        INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-root', 'project-a', 'ws-root-a', 'root');
        INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-wt', 'project-a', '${worktreeFolder.workspaceId}', 'wt');
        INSERT INTO sessions (id, project_id, workspace_id, title, archived_at) VALUES ('s-wt-archived', 'project-a', '${worktreeFolder.workspaceId}', 'old', '2026-10-01');
        INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-foreign', 'project-b', 'ws-root-a', 'foreign');
      `);

      const result = await listProjectFolders('project-a');

      expect(result).toEqual({
        success: true,
        data: [
          { workspaceId: 'ws-root-a', projectId: 'project-a', kind: 'root', path: rootA, branch: 'dev', sessionIds: ['s-root'], attachedAt: null },
          { workspaceId: relatedFolder.workspaceId, projectId: 'project-a', kind: 'attached', path: related, branch: null, sessionIds: [], attachedAt: relatedFolder.attachedAt },
          { workspaceId: worktreeFolder.workspaceId, projectId: 'project-a', kind: 'attached', path: worktree, branch: 'feat/7341-project-folders', sessionIds: ['s-wt'], attachedAt: worktreeFolder.attachedAt },
        ],
      });
    });

    it('别的项目挂的文件夹不出现在这里', async () => {
      await attachOk('project-b', worktree);
      const result = await listProjectFolders('project-a');
      expect(result.success && result.data.map((folder) => folder.workspaceId)).toEqual(['ws-root-a']);
    });

    it('项目还没有根目录那一行:当场建出来(与打开项目同一步),根目录仍在第一位', async () => {
      const rootC = path.join(tmp, 'fresh');
      await mkdir(rootC);
      fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('project-c', 'fresh', '${rootC}')`);

      const result = await listProjectFolders('project-c');

      expect(result.success).toBe(true);
      const [root] = result.success ? result.data : [];
      expect(root).toMatchObject({ kind: 'root', path: rootC, projectId: 'project-c' });
      const stored = fixture.sqlite.prepare(`SELECT repository_workspace_id AS id FROM projects WHERE id = 'project-c'`).get() as { id: string };
      expect(root?.workspaceId).toBe(stored.id);
      expect(workspaceRow(stored.id)).toMatchObject({ kind: 'project-root', path: rootC, project_id: null });
    });

    it('没有这个项目 ⇒ not-found', async () => {
      expect(await listProjectFolders('nope')).toEqual({
        success: false,
        error: { type: 'not-found', message: expect.stringContaining('nope') },
      });
    });
  });

  describe('attachProjectFolder', () => {
    it('挂上一个新文件夹:建一行 kind=path,记下项目与挂上的时间,通知项目文件夹变了', async () => {
      at('2026-10-16T08:30:00.000Z');
      const folder = await attachOk('project-a', `${worktree}/`);

      expect(folder).toMatchObject({
        projectId: 'project-a',
        kind: 'attached',
        path: worktree,
        branch: null,
        sessionIds: [],
        attachedAt: '2026-10-16T08:30:00.000Z',
      });
      expect(folder.workspaceId).not.toBe('ws-root-a');
      expect(workspaceRow(folder.workspaceId)).toEqual({
        id: folder.workspaceId,
        kind: 'path',
        path: worktree,
        project_id: 'project-a',
        attached_at: folder.attachedAt,
      });
      expect(mocks.emitted.filter((event) => event.name === FOLDERS_CHANGED)).toEqual([{ name: FOLDERS_CHANGED, data: { projectId: 'project-a' } }]);
    });

    it('同一个文件夹换一种写法再挂一次:还是那一行,不出第二行、不再通知、挂上的时间不变', async () => {
      at('2026-10-16T01:00:00.000Z');
      const first = await attachOk('project-a', worktree);
      const count = workspaceCount();
      mocks.emitted.length = 0;
      at('2026-10-16T05:00:00.000Z');

      const again = await attachOk('project-a', `${worktree}/`);

      expect(again.workspaceId).toBe(first.workspaceId);
      expect(again.attachedAt).toBe(first.attachedAt);
      expect(workspaceCount()).toBe(count);
      expect(mocks.emitted).toEqual([]);
    });

    it('已经挂在别的项目下 ⇒ belongs-to-other-project,说出是哪个项目;那边原样不动', async () => {
      const onB = await attachOk('project-b', worktree);

      const result = await attachProjectFolder('project-a', worktree);

      expect(result).toEqual({
        success: false,
        error: { type: 'belongs-to-other-project', projectId: 'project-b', projectName: 'other', message: expect.any(String) },
      });
      expect(workspaceRow(onB.workspaceId)?.project_id).toBe('project-b');
    });

    it('别的项目的根目录 ⇒ is-project-root(那个项目);自己的根目录也一样', async () => {
      expect(await attachProjectFolder('project-a', rootB)).toEqual({
        success: false,
        error: { type: 'is-project-root', projectId: 'project-b', projectName: 'other', message: expect.any(String) },
      });
      expect(await attachProjectFolder('project-a', `${rootA}/`)).toEqual({
        success: false,
        error: { type: 'is-project-root', projectId: 'project-a', projectName: 'gugu', message: expect.any(String) },
      });
      expect(workspaceRow('ws-root-b')?.project_id).toBeNull();
    });

    it('项目表里的路径与它根目录那一行记的路径不同:按根目录那一行认,同样是 is-project-root', async () => {
      // 会话在根目录那一行记着的路径里跑(workspace-bootstrap-service),所以那个路径就是这个项目的根目录。
      const rowPath = path.join(tmp, 'moved');
      await mkdir(rowPath);
      fixture.sqlite.exec(`
        INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-d', 'project-root', 'local', 'local', '${rowPath}', '${computeWorkspaceKey(rowPath)}');
        INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('project-d', 'moved', '${path.join(tmp, 'elsewhere')}', 'ws-root-d');
      `);

      expect(await attachProjectFolder('project-a', rowPath)).toEqual({
        success: false,
        error: { type: 'is-project-root', projectId: 'project-d', projectName: 'moved', message: expect.any(String) },
      });
      expect(workspaceRow('ws-root-d')).toMatchObject({ kind: 'project-root', project_id: null });
    });

    it('不是文件夹:文件、不存在的路径、相对路径都是 not-a-directory,一行都不写', async () => {
      const file = path.join(tmp, 'notes.txt');
      await writeFile(file, 'x');
      const count = workspaceCount();
      for (const candidate of [file, path.join(tmp, 'missing'), 'relative/dir']) {
        const result = await attachProjectFolder('project-a', candidate);
        expect(result.success ? 'ok' : result.error.type, candidate).toBe('not-a-directory');
      }
      expect(workspaceCount()).toBe(count);
      expect(mocks.emitted).toEqual([]);
    });

    it('没有这个项目 ⇒ not-found', async () => {
      const result = await attachProjectFolder('nope', worktree);
      expect(result.success ? 'ok' : result.error.type).toBe('not-found');
    });

    it('同一路径已有一条无主的旧行:认领它(沿用 id,kind 改成 path),在里面的本项目会话算这个文件夹的', async () => {
      fixture.sqlite.exec(`
        INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-old', 'worktree', 'local', 'local', '${worktree}', '${computeWorkspaceKey(worktree)}');
        INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-old', 'project-a', 'ws-old', 'old worktree session');
      `);

      const folder = await attachOk('project-a', worktree);

      expect(folder).toMatchObject({ workspaceId: 'ws-old', kind: 'attached', sessionIds: ['s-old'] });
      expect(workspaceRow('ws-old')).toMatchObject({ kind: 'path', project_id: 'project-a', attached_at: folder.attachedAt });
    });

    it('无主的旧行正被别的项目没归档的会话用着 ⇒ belongs-to-other-project,不认领', async () => {
      fixture.sqlite.exec(`
        INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-old', 'worktree', 'local', 'local', '${worktree}', '${computeWorkspaceKey(worktree)}');
        INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-b', 'project-b', 'ws-old', 'b session');
      `);

      expect(await attachProjectFolder('project-a', worktree)).toEqual({
        success: false,
        error: { type: 'belongs-to-other-project', projectId: 'project-b', projectName: 'other', message: expect.any(String) },
      });
      expect(workspaceRow('ws-old')).toMatchObject({ kind: 'worktree', project_id: null });
    });
  });

  describe('getProjectOwningAttachedFolder', () => {
    it('挂着的文件夹认作它所属的项目;摘下就不属于谁;根目录不归它答', async () => {
      expect(await getProjectOwningAttachedFolder(worktree)).toBeUndefined();
      const folder = await attachOk('project-a', worktree);
      // 换一种写法(尾斜杠)也是同一个文件夹。
      expect((await getProjectOwningAttachedFolder(`${worktree}/`))?.id).toBe('project-a');
      expect(await getProjectOwningAttachedFolder(rootA)).toBeUndefined();
      await detachProjectFolder('project-a', folder.workspaceId);
      expect(await getProjectOwningAttachedFolder(worktree)).toBeUndefined();
    });
  });

  describe('detachProjectFolder', () => {
    it('摘下:行还在(在里面的会话照旧),只是不再挂在项目下;通知项目文件夹变了', async () => {
      const folder = await attachOk('project-a', worktree);
      fixture.sqlite.exec(`INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('s-wt', 'project-a', '${folder.workspaceId}', 'wt')`);
      mocks.emitted.length = 0;

      expect(await detachProjectFolder('project-a', folder.workspaceId)).toEqual({ success: true });

      expect(workspaceRow(folder.workspaceId)).toEqual({
        id: folder.workspaceId,
        kind: 'path',
        path: worktree,
        project_id: null,
        attached_at: null,
      });
      const listed = await listProjectFolders('project-a');
      expect(listed.success && listed.data.map((f) => f.workspaceId)).toEqual(['ws-root-a']);
      expect(mocks.emitted.filter((event) => event.name === FOLDERS_CHANGED)).toEqual([{ name: FOLDERS_CHANGED, data: { projectId: 'project-a' } }]);
    });

    it('摘下再挂回来(撤销「摘下」):还是那一行,挂上的时间是这一次的', async () => {
      at('2026-10-16T01:00:00.000Z');
      const first = await attachOk('project-a', worktree);
      await detachProjectFolder('project-a', first.workspaceId);
      at('2026-10-16T09:00:00.000Z');

      const again = await attachOk('project-a', worktree);

      expect(again.workspaceId).toBe(first.workspaceId);
      expect(again.attachedAt).toBe('2026-10-16T09:00:00.000Z');
      expect(workspaceRow(first.workspaceId)).toMatchObject({ project_id: 'project-a', attached_at: '2026-10-16T09:00:00.000Z' });
    });

    it('摘除最后一个目录隐藏项目,保留文件和原工作区;撤销后沿用原项目和工作区', async () => {
      await writeFile(path.join(rootA, 'keep.txt'), 'keep my files');
      expect(await detachProjectFolder('project-a', 'ws-root-a')).toEqual({ success: true });
      expect(await listProjectFolders('project-a')).toEqual({ success: true, data: [] });
      expect(await resolveProjectFolder('project-a', 'ws-root-a')).toBeNull();
      expect((await getProjects()).map((project) => project.id)).toEqual(['project-b']);
      expect(await getProjectById('project-a')).toMatchObject({ rootFolderDetached: true, repositoryWorkspaceId: 'ws-root-a' });
      expect(workspaceRow('ws-root-a')).toMatchObject({ kind: 'project-root', path: rootA });
      expect(await readFile(path.join(rootA, 'keep.txt'), 'utf8')).toBe('keep my files');
      expect(mocks.emitted).toContainEqual({ name: 'project:visibility-changed', data: { projectId: 'project-a', project: null } });

      const restored = await attachOk('project-a', rootA);
      expect(restored).toMatchObject({ workspaceId: 'ws-root-a', kind: 'root', path: rootA });
      expect((await getProjects()).map((project) => project.id)).toContain('project-a');
      expect(await resolveProjectFolder('project-a', 'ws-root-a')).toEqual({ kind: 'root' });
      expect(workspaceCount()).toBe(2);
    });

    it('摘除根目录后还有挂载目录或未归档会话:项目仍可见,会话不归档、不删除', async () => {
      const attached = await attachOk('project-a', worktree);
      await detachProjectFolder('project-a', 'ws-root-a');
      expect((await getProjects()).map((project) => project.id)).toContain('project-a');
      fixture.sqlite.exec(`INSERT INTO sessions (id, project_id, workspace_id, title) VALUES ('keep-session', 'project-a', 'ws-root-a', 'keep')`);
      await detachProjectFolder('project-a', attached.workspaceId);
      expect(await listProjectFolders('project-a')).toEqual({ success: true, data: [] });
      expect((await getProjects()).map((project) => project.id)).toContain('project-a');
      expect(fixture.sqlite.prepare(`SELECT workspace_id, archived_at FROM sessions WHERE id = 'keep-session'`).get()).toEqual({ workspace_id: 'ws-root-a', archived_at: null });
    });

    it('摘除与重新挂回同时发生,初始目录仍恢复为同一个根工作区', async () => {
      const [detached, attached] = await Promise.all([
        detachProjectFolder('project-a', 'ws-root-a'),
        attachProjectFolder('project-a', rootA),
      ]);
      expect(detached.success).toBe(true);
      expect(attached.success).toBe(true);
      expect(await listProjectFolders('project-a')).toMatchObject({ success: true, data: [{ workspaceId: 'ws-root-a', kind: 'root' }] });
      expect(workspaceRow('ws-root-a')).toMatchObject({ kind: 'project-root', project_id: null });
      expect(workspaceCount()).toBe(2);
    });

    it('重新添加曾摘除的初始目录,恢复原项目而不撞路径唯一约束', async () => {
      await detachProjectFolder('project-a', 'ws-root-a');
      const result = await createLocalProject({ id: 'new-id', name: 'New', path: rootA, exactPath: true });
      expect(result).toMatchObject({ success: true, data: { id: 'project-a', repositoryWorkspaceId: 'ws-root-a' } });
      expect((await getProjects()).map((project) => project.id)).toContain('project-a');
      expect(fixture.sqlite.prepare(`SELECT id FROM projects WHERE id = 'new-id'`).get()).toBeUndefined();
    });

    it('磁盘目录暂时不存在不会把仍关联的项目当空项目清掉', async () => {
      await rm(rootA, { recursive: true });
      expect((await getProjects()).map((project) => project.id)).toContain('project-a');
      expect(await getProjectById('project-a')).toBeDefined();
    });

    it('没挂在这个项目下(不认识的 id、挂在别的项目下的)⇒ not-found,别的项目那边不动', async () => {
      const onB = await attachOk('project-b', worktree);
      mocks.emitted.length = 0;

      for (const id of ['ws-unknown', onB.workspaceId]) {
        const result = await detachProjectFolder('project-a', id);
        expect(result.success ? 'ok' : result.error.type, id).toBe('not-found');
      }
      expect(workspaceRow(onB.workspaceId)?.project_id).toBe('project-b');
      expect(mocks.emitted).toEqual([]);
    });
  });

  describe('resolveProjectFolder', () => {
    it('根目录 → root;挂上的 → attached + 路径;别的项目的、不认识的 → null', async () => {
      const mine = await attachOk('project-a', worktree);
      const theirs = await attachOk('project-b', related);

      expect(await resolveProjectFolder('project-a', 'ws-root-a')).toEqual({ kind: 'root' });
      expect(await resolveProjectFolder('project-a', mine.workspaceId)).toEqual({
        kind: 'attached',
        path: worktree,
        workspaceKind: 'path',
      });
      expect(await resolveProjectFolder('project-a', theirs.workspaceId)).toBeNull();
      expect(await resolveProjectFolder('project-a', 'ws-root-b')).toBeNull();
      expect(await resolveProjectFolder('project-a', 'ws-unknown')).toBeNull();
      expect(await resolveProjectFolder('nope', 'ws-root-a')).toBeNull();
    });
  });

  it('项目删了:它挂的文件夹放回无主(外键 SET NULL),行还在', async () => {
    const folder = await attachOk('project-b', worktree);
    fixture.sqlite.exec(`DELETE FROM projects WHERE id = 'project-b'`);
    expect(workspaceRow(folder.workspaceId)).toMatchObject({ path: worktree, project_id: null });
    // 放回无主之后,别的项目可以挂它
    const claimed = await attachOk('project-a', worktree);
    expect(claimed.workspaceId).toBe(folder.workspaceId);
  });
});
