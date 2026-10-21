import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteWorkspaceIfUnused,
    pathExists,
  removeOwnedLocalWorktreeDirectory,
} from './session-lifecycle-utils';

const mocks = vi.hoisted(() => ({
  deleteWhere: vi.fn(),
  createBoundExec: vi.fn(),
  gitExec: vi.fn(),
  selectLimit: vi.fn(),
  deleteIndex: vi.fn(),
}));

vi.mock('@gugu/session-core/exec', () => ({
  createBoundExec: mocks.createBoundExec,
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: mocks.selectLimit,
        }),
      }),
    }),
    delete: () => ({
      where: mocks.deleteWhere,
    }),
  },
}));

vi.mock('@main/core/search/workspace-file-index-service', () => ({
  workspaceFileIndexService: {
    deleteIndex: mocks.deleteIndex,
  },
}));

describe('task lifecycle workspace cleanup', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.deleteWhere.mockResolvedValue(undefined);
    mocks.gitExec.mockResolvedValue({ stdout: '', stderr: '' });
    mocks.createBoundExec.mockReturnValue({ exec: mocks.gitExec });
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'emdash-task-cleanup-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('deletes the workspace index when deleting the unreferenced workspace row', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([]);

    await deleteWorkspaceIfUnused('workspace-1', 'task-1');

    expect(mocks.deleteWhere).toHaveBeenCalledOnce();
    expect(mocks.deleteIndex).toHaveBeenCalledWith('workspace-1');
  });

  // #7341 挂在项目下的文件夹是项目的一部分:在里面的最后一条会话删了,它照样挂着(上面那条是阳控:无主的行会删)。
  it('keeps a folder attached to a project when its last session is deleted', async () => {
    // 只排一次:挂着的文件夹第一问就返回,多排的那一个会漏给下一条用例(实撞:下一条因此读到「还有会话」而判红)。
    mocks.selectLimit.mockResolvedValueOnce([{ id: 'workspace-1', kind: 'path', projectId: 'project-1' }]);

    await deleteWorkspaceIfUnused('workspace-1', 'task-1');

    expect(mocks.selectLimit).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.deleteIndex).not.toHaveBeenCalled();
  });

  it('deletes a detached folder row once nothing references it', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'path', projectId: null }])
      .mockResolvedValueOnce([]);

    await deleteWorkspaceIfUnused('workspace-1', 'task-1');

    expect(mocks.deleteWhere).toHaveBeenCalledOnce();
  });

  it('preserves the workspace index while an archived sibling still references the workspace', async () => {
    mocks.selectLimit
      .mockResolvedValueOnce([{ id: 'workspace-1', kind: 'worktree' }])
      .mockResolvedValueOnce([{ id: 'archived-sibling' }]);

    await deleteWorkspaceIfUnused('workspace-1', 'task-1');

    expect(mocks.deleteWhere).not.toHaveBeenCalled();
    expect(mocks.deleteIndex).not.toHaveBeenCalled();
  });

  it('refuses to remove the project root', async () => {
    const projectPath = path.join(tempDir, 'project');
    await mkdir(projectPath, { recursive: true });

    const removal = await removeOwnedLocalWorktreeDirectory(
      {
        kind: 'worktree',
        type: 'local',
        location: 'local',
        path: projectPath,
      },
      projectPath
    );

    expect(removal.success).toBe(false);
    if (removal.success) return;
    expect(removal.error.type).toBe('project-root-refused');
    await expect(pathExists(projectPath)).resolves.toBe(true);
  });
});
