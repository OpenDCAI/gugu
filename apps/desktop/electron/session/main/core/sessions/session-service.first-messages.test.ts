import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ id: string; runtime?: string; initialQueue?: Array<{ text: string }> }>,
  enqueue: vi.fn(),
}));

vi.mock('@main/core/projects/project-manager', () => ({ projectManager: {} }));
vi.mock('@main/core/workspaces/workspace-bootstrap-service', () => ({ workspaceBootstrapService: {} }));
vi.mock('@main/core/workspaces/workspace-registry', () => ({ workspaceRegistry: { get: () => ({ path: '/repo' }) } }));
// One row read serves both the provision (its project) and the admission (the session as mapped).
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ projectId: 'p', ...mocks.sessions[0] }] }) }) }) } }));
vi.mock('./utils', () => ({ mapSessionRowToSession: (row: unknown) => row }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', projectId: 'projectId' } }));
vi.mock('drizzle-orm', () => ({ eq: () => null }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./operations/createSession', () => ({ createSession: vi.fn() }));
vi.mock('./session-life-creation', () => ({ enqueueCreationTurns: mocks.enqueue }));
vi.mock('./session-workspace-manager', () => ({ sessionWorkspaceManager: { getWorkspaceId: () => 'w' } }));

const { sessionService } = await import('./session-service');

/**
 * A task page that creates its own session provisions it right after: the session's first message becomes its first
 * pending row only then, once the workspace exists (a fresh profile's first workspace is not registered before that).
 */
describe('provisionWorkspace admits a never-run ACP session\'s first messages', () => {
  beforeEach(() => { mocks.enqueue.mockClear(); });

  it('admits them once the workspace exists', async () => {
    mocks.sessions = [{ id: 's', runtime: 'acp', initialQueue: [{ text: '开工' }] }];
    await sessionService.provisionWorkspace('s');
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(mocks.sessions[0]));
  });

  it('leaves a terminal session, and an ACP session without first messages, alone', async () => {
    mocks.sessions = [{ id: 's', runtime: 'pty', initialQueue: [{ text: '开工' }] }];
    await sessionService.provisionWorkspace('s');
    mocks.sessions = [{ id: 's', runtime: 'acp' }];
    await sessionService.provisionWorkspace('s');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
