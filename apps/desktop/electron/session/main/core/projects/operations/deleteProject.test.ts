import { ok } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteProject } from './deleteProject';

const mocks = vi.hoisted(() => ({
  closeProject: vi.fn(),
  deleteProjectData: vi.fn(),
  deleteProjectRow: vi.fn(),
  deleteWhere: vi.fn(),
  returningDeleted: vi.fn(),
  delViewState: vi.fn(),
  forgetSessionOutputs: vi.fn(),
  getProject: vi.fn(),
  sessionsOfProject: vi.fn(),
  projectEmit: vi.fn(),
  teardownSession: vi.fn(),
}));

vi.mock('@main/core/projects/project-events', () => ({
  projectEvents: { _emit: mocks.projectEmit },
}));

vi.mock('@main/db/client', () => ({
  db: {
    delete: mocks.deleteProjectRow,
    select: () => ({ from: () => ({ where: mocks.sessionsOfProject }) }),
  },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    getProject: mocks.getProject,
    closeProject: mocks.closeProject,
  },
}));

vi.mock('@main/core/sessions/session-workspace-manager', () => ({
  sessionWorkspaceManager: {
    teardownSession: mocks.teardownSession,
  },
}));

vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({
  prSyncEngine: {
    deleteProjectData: mocks.deleteProjectData,
  },
}));

vi.mock('@main/core/sessions/session-outputs', () => ({
  forgetSessionOutputs: mocks.forgetSessionOutputs,
}));

vi.mock('@main/core/view-state/view-state-service', () => ({
  viewStateService: {
    del: mocks.delViewState,
  },
}));

describe('deleteProject', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.deleteProjectRow.mockReturnValue({ where: mocks.deleteWhere });
    mocks.deleteWhere.mockReturnValue({ returning: mocks.returningDeleted });
    mocks.returningDeleted.mockResolvedValue([{ id: 'project-1' }]);
    mocks.sessionsOfProject.mockResolvedValue([{ id: 'session-1' }]);
    mocks.getProject.mockReturnValue({ projectId: 'project-1' });
    mocks.closeProject.mockResolvedValue(ok());
    mocks.teardownSession.mockResolvedValue(ok());
    mocks.deleteProjectData.mockResolvedValue(undefined);
    mocks.delViewState.mockResolvedValue(undefined);
  });

  it('closes a mounted project before deleting its database row', async () => {
    await deleteProject('project-1');

    expect(mocks.closeProject).toHaveBeenCalledWith('project-1');
    expect(mocks.teardownSession).toHaveBeenCalledWith('session-1');
    expect(mocks.delViewState).toHaveBeenCalledWith('session:session-1:tabs');
    expect(mocks.forgetSessionOutputs).toHaveBeenCalledWith('session-1');
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
    const closeOrder = mocks.closeProject.mock.invocationCallOrder[0];
    const deleteOrder = mocks.deleteWhere.mock.invocationCallOrder[0];
    expect(closeOrder).toBeDefined();
    expect(deleteOrder).toBeDefined();
    expect(closeOrder!).toBeLessThan(deleteOrder!);
  });

  it('deletes an unmounted project without closing a provider, still clearing what its sessions left behind', async () => {
    mocks.getProject.mockReturnValue(undefined);

    await deleteProject('project-1');

    expect(mocks.closeProject).not.toHaveBeenCalled();
    expect(mocks.teardownSession).not.toHaveBeenCalled();
    // Its sessions go with it (foreign-key cascade): their view state and outputs are cleared here, not guessed at boot.
    expect(mocks.delViewState).toHaveBeenCalledWith('session:session-1');
    expect(mocks.delViewState).toHaveBeenCalledWith('session:session-1:tabs');
    expect(mocks.forgetSessionOutputs).toHaveBeenCalledWith('session-1');
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it('does not publish a deletion when no project row was removed', async () => {
    mocks.getProject.mockReturnValue(undefined);
    mocks.returningDeleted.mockResolvedValue([]);
    await deleteProject('missing');
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });

  it('cleans PR sync data before deleting the project row', async () => {
    await deleteProject('project-1');

    expect(mocks.deleteProjectData).toHaveBeenCalledWith('project-1');
    expect(mocks.deleteProjectRow).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);

    expect(mocks.deleteProjectData.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.deleteProjectRow.mock.invocationCallOrder[0]
    );
  });
});
