import { ok, err } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteProject, getProjectDeletionImpact } from './deleteProject';

const mocks = vi.hoisted(() => ({
  closeProject: vi.fn(), deleteProjectData: vi.fn(), deleteProjectRow: vi.fn(), deleteWhere: vi.fn(),
  returningDeleted: vi.fn(), delViewState: vi.fn(), getProject: vi.fn(), sessionsOfProject: vi.fn(),
  projectEmit: vi.fn(), archiveSession: vi.fn(), folders: vi.fn(), detach: vi.fn(),
  update: vi.fn(), updateWhere: vi.fn(), bindings: vi.fn(), countAgents: vi.fn(), getProjectById: vi.fn(),
}));

vi.mock('@main/core/projects/project-events', () => ({ projectEvents: { _emit: mocks.projectEmit } }));
vi.mock('@main/db/client', () => ({ db: {
  delete: mocks.deleteProjectRow,
  select: () => ({ from: () => ({ where: mocks.sessionsOfProject }) }),
  update: () => ({ set: mocks.update }),
} }));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: mocks.getProject, closeProject: mocks.closeProject },
}));
vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({ prSyncEngine: { deleteProjectData: mocks.deleteProjectData } }));
vi.mock('@main/core/view-state/view-state-service', () => ({ viewStateService: { del: mocks.delViewState } }));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: mocks.archiveSession }));
vi.mock('./project-folders', () => ({ listProjectFolderRefs: mocks.folders, detachProjectFolder: mocks.detach }));
vi.mock('./getProjects', () => ({ getProjectById: mocks.getProjectById }));
vi.mock('@main/core/projects/project-group-host', () => ({ projectGroupHost: () => ({ listBindings: mocks.bindings }) }));
vi.mock('@main/core/sessionpage/sessionpage-session-agent', () => ({ countSessionAgents: mocks.countAgents }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.deleteProjectRow.mockReturnValue({ where: mocks.deleteWhere });
  mocks.deleteWhere.mockReturnValue({ returning: mocks.returningDeleted });
  mocks.returningDeleted.mockResolvedValue([{ id: 'project-1' }]);
  mocks.sessionsOfProject.mockResolvedValue([{ id: 'session-1' }]);
  mocks.getProject.mockReturnValue({ projectId: 'project-1' });
  mocks.closeProject.mockResolvedValue(ok());
  mocks.archiveSession.mockResolvedValue({ archived: [], unreached: [] });
  mocks.folders.mockResolvedValue([{ workspaceId: 'root' }, { workspaceId: 'attached' }]);
  mocks.detach.mockResolvedValue(ok());
  mocks.update.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockResolvedValue(undefined);
  mocks.bindings.mockResolvedValue(ok([{ projectId: 'project-1', chatId: 'group-1' }]));
  mocks.countAgents.mockResolvedValue(1);
  mocks.getProjectById.mockResolvedValue({ id: 'project-1' });
});

describe('deleteProject', () => {
  it('archives before closing, detaches all folders and retains task outputs and bindings', async () => {
    mocks.sessionsOfProject.mockResolvedValue([{ id: 'session-1' }, { id: 'already-archived' }]);
    await deleteProject('project-1');
    expect(mocks.archiveSession.mock.calls).toEqual([
      ['project-1', 'session-1'], ['project-1', 'already-archived'],
    ]);
    expect(mocks.archiveSession.mock.invocationCallOrder[1]).toBeLessThan(mocks.closeProject.mock.invocationCallOrder[0]!);
    expect(mocks.detach.mock.calls).toEqual([['project-1', 'root'], ['project-1', 'attached']]);
    expect(mocks.update).toHaveBeenCalledWith({ projectId: null });
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
    expect(mocks.delViewState.mock.calls).toEqual([['project:project-1']]);
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });

  it('archives tasks in an unmounted project too', async () => {
    mocks.getProject.mockReturnValue(undefined);
    await deleteProject('project-1');
    expect(mocks.archiveSession).toHaveBeenCalledWith('project-1', 'session-1');
    expect(mocks.closeProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
  });

  it('archives a task created during removal after all folders have been detached', async () => {
    mocks.sessionsOfProject
      .mockResolvedValueOnce([{ id: 'session-1' }])
      .mockResolvedValueOnce([{ id: 'session-1' }, { id: 'created-during-removal' }]);
    await deleteProject('project-1');
    expect(mocks.archiveSession.mock.calls).toEqual([
      ['project-1', 'session-1'], ['project-1', 'created-during-removal'],
    ]);
    expect(mocks.archiveSession.mock.invocationCallOrder[1]).toBeGreaterThan(mocks.detach.mock.invocationCallOrder[1]!);
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
  });

  it('reports failure to archive a task created during removal instead of reporting success', async () => {
    mocks.sessionsOfProject
      .mockResolvedValueOnce([{ id: 'session-1' }])
      .mockResolvedValueOnce([{ id: 'created-during-removal' }]);
    mocks.archiveSession.mockResolvedValueOnce({ archived: [], unreached: [] })
      .mockRejectedValueOnce(new Error('new task runtime stop failed'));
    await expect(deleteProject('project-1')).rejects.toThrow('new task runtime stop failed');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });

  it('keeps the original true deletion and PR cleanup for an empty project', async () => {
    mocks.sessionsOfProject.mockResolvedValue([]);
    await deleteProject('project-1');
    expect(mocks.archiveSession).not.toHaveBeenCalled();
    expect(mocks.folders).not.toHaveBeenCalled();
    expect(mocks.deleteProjectRow).toHaveBeenCalledOnce();
    expect(mocks.closeProject.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteWhere.mock.invocationCallOrder[0]!);
    expect(mocks.deleteProjectData.mock.invocationCallOrder[0]).toBeLessThan(mocks.deleteWhere.mock.invocationCallOrder[0]!);
    expect(mocks.projectEmit).toHaveBeenCalledWith('project:deleted', 'project-1');
  });

  it('does not publish removal of a missing empty project', async () => {
    mocks.sessionsOfProject.mockResolvedValue([]);
    mocks.getProject.mockReturnValue(undefined);
    mocks.returningDeleted.mockResolvedValue([]);
    await deleteProject('missing');
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });

  it('does not detach or delete after task archival fails', async () => {
    mocks.archiveSession.mockRejectedValue(new Error('runtime stop failed'));
    await expect(deleteProject('project-1')).rejects.toThrow('runtime stop failed');
    expect(mocks.folders).not.toHaveBeenCalled();
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });

  it('reports a folder-detachment failure and keeps every task row', async () => {
    mocks.detach.mockResolvedValue(err({ type: 'not-found', message: 'folder changed' }));
    await expect(deleteProject('project-1')).rejects.toThrow('folder changed');
    expect(mocks.deleteProjectRow).not.toHaveBeenCalled();
    expect(mocks.projectEmit).not.toHaveBeenCalled();
  });
});

describe('getProjectDeletionImpact', () => {
  it('reads task rows and unique associated groups from the host, not the visible task list', async () => {
    mocks.sessionsOfProject.mockResolvedValue([{ id: 'live' }, { id: 'archived' }]);
    mocks.bindings.mockResolvedValue(ok([{ chatId: 'same' }, { chatId: 'same' }]));
    expect(await getProjectDeletionImpact('project-1')).toEqual({ tasks: 2, agents: 1, groups: 1 });
    expect(mocks.countAgents).toHaveBeenCalledWith(['live', 'archived'], process.env);
  });

  it('never reports unreadable group bindings as zero groups', async () => {
    mocks.bindings.mockResolvedValue(err({ type: 'not-signed-in', message: 'owner unavailable' }));
    await expect(getProjectDeletionImpact('project-1')).rejects.toThrow('owner unavailable');
  });

  it('does not report a missing project as an empty one', async () => {
    mocks.getProjectById.mockResolvedValue(undefined);
    await expect(getProjectDeletionImpact('missing')).rejects.toThrow('Project not found');
  });
});
