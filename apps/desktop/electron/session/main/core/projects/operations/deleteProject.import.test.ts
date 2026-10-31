import { describe, expect, it, vi } from 'vitest';

// A project reader may load the deletion operation without having an Agent
// runtime available. Only actually archiving a task may load that dependency.
vi.mock('@main/core/sessions/archiveSession', () => {
  throw new Error('archive runtime import sentinel');
});
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => undefined } }));
vi.mock('@main/core/projects/project-events', () => ({ projectEvents: { _emit: vi.fn() } }));
vi.mock('@main/core/pull-requests/pr-sync-engine', () => ({ prSyncEngine: { deleteProjectData: async () => {} } }));
vi.mock('@main/core/view-state/view-state-service', () => ({ viewStateService: { del: vi.fn() } }));
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: async () => [] }) }),
  transaction: (run: (tx: unknown) => unknown) => run({
    select: () => ({ from: () => ({ where: () => ({ all: () => [] }) }) }),
    delete: () => ({ where: () => ({ returning: () => ({ all: () => [] }) }) }),
  }),
} }));

describe('project operation import boundary', () => {
  it('can load the operation and remove an empty project without loading the archive runtime', async () => {
    const { deleteProject } = await import('./deleteProject');
    await expect(deleteProject('empty-project')).resolves.toBeUndefined();
  });

  it('proves the archive dependency sentinel is active', async () => {
    await expect(import('@main/core/sessions/archiveSession')).rejects.toMatchObject({
      cause: { message: 'archive runtime import sentinel' },
    });
  });
});
