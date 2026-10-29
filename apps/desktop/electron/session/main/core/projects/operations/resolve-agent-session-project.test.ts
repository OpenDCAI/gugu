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
    // #609 automatic:替人登记的,落在 ~ / GUGU_HOME 底下就是 workspace(人亲手「添加项目」不带它)。
    expect.objectContaining({ path: dir, allowNonGit: true, reuseExisting: true, exactPath: true, automatic: true }),
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

// #609 (owner 2026-10-28, supersedes 2026-09-25): no directory ⇒ this machine's task workspace, on a gugu server too.
// ❌ $HOME: that registered ~ as a project nobody created and showed it as a「~ · machine」row.
it('没给目录:server 也进任务工作区,❌ 落主目录', async () => {
  vi.stubEnv('GUGU_SERVER_MODE', '1');
  const project = await resolveAgentSessionProject('');
  expect(project.id).toBe('00000000-0000-4000-8000-000000000001');
  expect(mocks.byPath).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
});

