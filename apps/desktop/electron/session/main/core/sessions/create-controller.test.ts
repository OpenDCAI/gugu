import { beforeEach, expect, it, vi } from 'vitest';
import type { CreateSessionParams } from '@shared/core/sessions/create-session';

const calls = vi.hoisted(() => ({ create: vi.fn(), provision: vi.fn(), admit: vi.fn() }));
vi.mock('./session-service', () => ({ sessionService: { createSession: calls.create, provisionWorkspace: calls.provision } }));
vi.mock('./session-life-creation', () => ({ admitFirstMessages: calls.admit }));
vi.mock('./name-generation/generateSessionName', () => ({ generateSessionName: vi.fn() }));
vi.mock('./operations/getProjectWorkspaces', () => ({ getProjectWorkspaces: vi.fn() }));
import { sessionCreateController } from './create-controller';

const input = { projectId: 'project', sessionConfig: { initialSession: { id: 'new-task' } } } as CreateSessionParams;
beforeEach(() => {
  vi.clearAllMocks();
  calls.create.mockResolvedValue({ success: true, data: {} });
  calls.provision.mockResolvedValue({ success: true, data: { path: '/workspace', workspaceId: 'workspace' } });
  calls.admit.mockResolvedValue(undefined);
});

it('creates and prepares the task before admitting its initial turn, within one RPC', async () => {
  const result = await sessionCreateController.createAndProvisionSession(input);
  expect(result).toEqual({ stage: 'provision', result: { success: true, data: { path: '/workspace', workspaceId: 'workspace' } } });
  expect(calls.create).toHaveBeenCalledExactlyOnceWith(input);
  expect(calls.provision).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.admit).toHaveBeenCalledExactlyOnceWith('new-task');
  expect(calls.create.mock.invocationCallOrder[0]).toBeLessThan(calls.provision.mock.invocationCallOrder[0]);
  expect(calls.provision.mock.invocationCallOrder[0]).toBeLessThan(calls.admit.mock.invocationCallOrder[0]);
});

it('leaves attachment turns deferred for the existing placement admission', async () => {
  await sessionCreateController.createAndProvisionSession(input, { deferFirstTurn: true });
  expect(calls.provision).toHaveBeenCalledOnce();
  expect(calls.admit).not.toHaveBeenCalled();
});

it('does not prepare or admit a task which creation refused', async () => {
  const failure = { success: false, error: { type: 'project-not-found' } };
  calls.create.mockResolvedValueOnce(failure);
  expect(await sessionCreateController.createAndProvisionSession(input)).toEqual({ stage: 'create', result: failure });
  expect(calls.provision).not.toHaveBeenCalled();
  expect(calls.admit).not.toHaveBeenCalled();
});

it('reports a preparation exception as an existing task, preserving the actual reason', async () => {
  calls.provision.mockRejectedValueOnce(new Error('The workspace could not be mounted'));
  expect(await sessionCreateController.createAndProvisionSession(input)).toEqual({ stage: 'provision-error', message: 'The workspace could not be mounted' });
  expect(calls.create).toHaveBeenCalledOnce();
  expect(calls.admit).not.toHaveBeenCalled();
});
