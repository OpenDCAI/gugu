// #6264 — 刚装好的咕咕 server 没有渲染层,库里一个项目都没有;云端 agent.create 必须照样落得了脚。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  byPath: vi.fn(),
  byId: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@main/core/projects/operations/getProjects', () => ({
  getLocalProjectByPath: mocks.byPath,
  getProjectById: mocks.byId,
}));
vi.mock('@main/core/projects/operations/create-local-project', () => ({
  createLocalProject: mocks.create,
}));
vi.mock('@main/core/app/session-home-dir', () => ({ sessionHomeDir: () => '/srv/home/task-home' }));

import { resolveAgentSessionProject } from './resolve-agent-session-project';

beforeEach(() => {
  mocks.byPath.mockReset().mockResolvedValue(undefined);
  mocks.byId.mockReset().mockResolvedValue(undefined);
  mocks.create.mockReset().mockImplementation(async (params: { id?: string; path: string }) => ({
    success: true,
    data: { id: params.id ?? 'new-project', path: params.path },
  }));
});

it('目录已经是项目:直接用,不再登记', async () => {
  mocks.byPath.mockResolvedValue({ id: 'p1', path: '/work/app' });
  expect(await resolveAgentSessionProject('/work/app')).toEqual({ id: 'p1', path: '/work/app' });
  expect(mocks.create).not.toHaveBeenCalled();
});

it('目录存在但还没登记:当场登记成项目(非 git 也行,用目录本身)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gugu-6264-proj-'));
  const project = await resolveAgentSessionProject(dir);
  expect(project.path).toBe(dir);
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ path: dir, allowNonGit: true, reuseExisting: true, exactPath: true }),
  );
});

it('目录不存在:报出是哪个目录', async () => {
  await expect(resolveAgentSessionProject('/no/such/dir-6264')).rejects.toThrow('/no/such/dir-6264');
  expect(mocks.create).not.toHaveBeenCalled();
});

it('没给目录、也还没有任务工作区:主进程自己建(与渲染层同一个 id)', async () => {
  const project = await resolveAgentSessionProject('  ');
  expect(project).toEqual({ id: '00000000-0000-4000-8000-000000000001', path: '/srv/home/task-home' });
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({ id: '00000000-0000-4000-8000-000000000001', name: '任务工作区', createDirectory: true }),
  );
});

it('任务工作区已经有了:直接用', async () => {
  mocks.byId.mockResolvedValue({ id: '00000000-0000-4000-8000-000000000001', path: '/x' });
  await resolveAgentSessionProject('');
  expect(mocks.create).not.toHaveBeenCalled();
});

// owner 2026-09-25:无界面的咕咕 server 收到不带目录的创建(手机建会话、云端 agent.create、远端建「已安排」)
// ⇒ 落在 $HOME 的主目录项目里、会话真的在 $HOME 跑;桌面机不变(仍进任务工作区)。
it('server 模式没给目录:落在主目录项目(已有同路径项目就复用)', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gugu-6264-home-'));
  const server = { serverMode: true, homeDir: () => home };
  const project = await resolveAgentSessionProject('', server);
  expect(project.path).toBe(home);
  expect(mocks.byId).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ path: home, allowNonGit: true, reuseExisting: true }));

  mocks.create.mockClear();
  mocks.byPath.mockResolvedValue({ id: 'home-project', path: home });
  expect(await resolveAgentSessionProject('  ', server)).toEqual({ id: 'home-project', path: home });
  expect(mocks.create).not.toHaveBeenCalled();
});

it('桌面模式没给目录:照旧进任务工作区,❌ 落主目录', async () => {
  const project = await resolveAgentSessionProject('', { serverMode: false, homeDir: () => '/home/should-not-use' });
  expect(project.id).toBe('00000000-0000-4000-8000-000000000001');
  expect(mocks.byPath).not.toHaveBeenCalled();
});
