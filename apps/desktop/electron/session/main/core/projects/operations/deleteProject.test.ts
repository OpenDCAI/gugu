import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteProject } from './deleteProject';
const m = vi.hoisted(() => ({ archive: vi.fn(), close: vi.fn(), rows: vi.fn(), current: vi.fn(), remove: vi.fn(), set: vi.fn(), update: vi.fn(), emit: vi.fn() }));
vi.mock('@main/core/projects/project-events', () => ({ projectEvents: { _emit: m.emit } }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => ({}), closeProject: m.close } }));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: m.archive }));
vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({ prSyncEngine: { deleteProjectData: vi.fn() } }));
vi.mock('@main/core/view-state/view-state-service', () => ({ viewStateService: { del: vi.fn() } }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: m.rows }) }),
  update: () => ({ set: m.set }),
  transaction: (run: (tx: unknown) => unknown) => run({
    select: () => ({ from: () => ({ where: () => ({ all: m.current }) }) }),
    delete: () => ({ where: () => ({ returning: () => ({ all: m.remove }) }) }),
  }),
} }));
describe('project removal archives tasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.rows.mockResolvedValue([{ id: 'task' }]);
    m.current.mockReturnValue([{ id: 'task' }]);
    m.set.mockReturnValue({ where: m.update }); m.remove.mockReturnValue([{ id: 'project' }]);
  });
  it('archives tasks and hides the project without discarding its folder bindings', async () => {
    await deleteProject('project');
    expect(m.archive).toHaveBeenCalledWith('project', 'task');
    expect(m.set).toHaveBeenCalledWith({ archivedAt: expect.any(String) });
    expect(m.archive.mock.invocationCallOrder[0]).toBeLessThan(m.set.mock.invocationCallOrder[0]);
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.emit).toHaveBeenCalledWith('project:deleted', 'project');
    expect(m.set.mock.invocationCallOrder[0]).toBeLessThan(m.emit.mock.invocationCallOrder[0]);
  });
  it('keeps the project attached if archival fails', async () => {
    m.archive.mockRejectedValueOnce(new Error('stop failed'));
    await expect(deleteProject('project')).rejects.toThrow('stop failed');
    expect(m.update).not.toHaveBeenCalled(); expect(m.remove).not.toHaveBeenCalled();
  });
  it('keeps the existing empty-project removal', async () => {
    m.rows.mockResolvedValue([]);
    m.current.mockReturnValue([]);
    await deleteProject('project');
    expect(m.remove).toHaveBeenCalledOnce(); expect(m.emit).toHaveBeenCalledWith('project:deleted', 'project');
  });
  it('archives a task which arrives after an initially empty inventory instead of cascading it', async () => {
    m.rows.mockResolvedValue([]);
    m.current.mockReturnValue([{ id: 'arrived' }]);
    await deleteProject('project');
    expect(m.archive).toHaveBeenCalledWith('project', 'arrived');
    expect(m.remove).not.toHaveBeenCalled();
    expect(m.set).toHaveBeenCalledWith({ archivedAt: expect.any(String) });
  });
  it('re-reads after the original archival and includes another task which arrived meanwhile', async () => {
    m.archive.mockImplementationOnce(async () => { m.current.mockReturnValue([{ id: 'task' }, { id: 'arrived' }]); });
    await deleteProject('project');
    expect(m.archive).toHaveBeenCalledWith('project', 'arrived');
    expect(m.current.mock.invocationCallOrder[0]).toBeGreaterThan(m.archive.mock.invocationCallOrder[0]);
    expect(m.remove).not.toHaveBeenCalled();
  });
});
