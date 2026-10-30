import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteProject } from './deleteProject';
const m = vi.hoisted(() => ({ archive: vi.fn(), close: vi.fn(), rows: vi.fn(), detach: vi.fn(), folders: vi.fn(), remove: vi.fn(), update: vi.fn(), emit: vi.fn() }));
vi.mock('@main/core/projects/project-events', () => ({ projectEvents: { _emit: m.emit } }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => ({}), closeProject: m.close } }));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: m.archive }));
vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({ prSyncEngine: { deleteProjectData: vi.fn() } }));
vi.mock('@main/core/view-state/view-state-service', () => ({ viewStateService: { del: vi.fn() } }));
vi.mock('./project-folders', () => ({ listProjectFolderRefs: m.folders, detachProjectFolder: m.detach }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: m.rows }) }),
  update: () => ({ set: () => ({ where: m.update }) }),
  delete: () => ({ where: () => ({ returning: m.remove }) }),
} }));
describe('project removal archives tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.rows.mockResolvedValue([{ id: 'task' }]); m.folders.mockResolvedValue([{ workspaceId: 'folder' }]);
    m.detach.mockResolvedValue({ success: true }); m.remove.mockResolvedValue([{ id: 'project' }]);
  });
  it('archives before detaching and preserves the project row used by Restore', async () => {
    await deleteProject('project');
    expect(m.archive).toHaveBeenCalledWith('project', 'task');
    expect(m.detach).toHaveBeenCalledWith('project', 'folder');
    expect(m.archive.mock.invocationCallOrder[0]).toBeLessThan(m.detach.mock.invocationCallOrder[0]);
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.emit).toHaveBeenCalledWith('project:deleted', 'project');
    expect(m.detach.mock.invocationCallOrder[0]).toBeLessThan(m.emit.mock.invocationCallOrder[0]);
  });
  it('keeps the project attached if archival fails', async () => {
    m.archive.mockRejectedValueOnce(new Error('stop failed'));
    await expect(deleteProject('project')).rejects.toThrow('stop failed');
    expect(m.detach).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
  });
  it('keeps the existing empty-project removal', async () => {
    m.rows.mockResolvedValue([]);
    await deleteProject('project');
    expect(m.remove).toHaveBeenCalledOnce(); expect(m.emit).toHaveBeenCalledWith('project:deleted', 'project');
  });
});
