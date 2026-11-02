import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resumeHostUpdate } from './resume-host-update';
import { sessionDirectMessageId, stableUuid } from '../sessions/session-direct-identity';
import { sessionBootTasks } from '../boot-tasks';

const mocks = vi.hoisted(() => ({ send: vi.fn(async (..._args: unknown[]) => ({ id: 'notice' })) }));
vi.mock('../sessions/session-orchestration', () => ({ messageSessionFrom: mocks.send }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
beforeEach(() => {
  mocks.send.mockClear();
  for (const failure of sessionBootTasks.snapshot()) sessionBootTasks.clear(failure.operation, failure.taskId);
});

describe('resuming work interrupted by a host update', () => {
  const update = { reason: 'update', at: 1_793_598_000_000 } as const;

  it('uses the system notice and existing durable message key for every settled session', async () => {
    await resumeHostUpdate(['claude', 'codex'], update, '0.3.1-beta.1129');
    expect(mocks.send).toHaveBeenCalledTimes(2);
    for (const [index, sessionId] of ['claude', 'codex'].entries()) {
      const [envelope, id, text, options] = mocks.send.mock.calls[index] as unknown as [
        (messageId: string, content: string) => string, string, string, unknown,
      ];
      expect(id).toBe(sessionId);
      expect(text).toMatch(/^Your work was interrupted at .+ because Gugu on this machine restarted to update to 0\.3\.1-beta\.1129\./);
      expect(text).toContain('Commands that were running did not report back; check their state, then continue from where you stopped.');
      expect(text).toContain('If a tool call immediately before this notice says it was rejected or interrupted by the user, that was this restart cancelling the request, not a refusal by the user. If you still need the same operation, request approval for it again.');
      expect(text).not.toMatch(/\bturn\b|轮|回合/);
      expect(options).toEqual({ keyScope: 'host:update', receipt: {
        id: stableUuid(['host:update', 'update-interrupted', String(update.at)]), at: new Date(update.at).toISOString(),
      } });
      expect(envelope('notice-id', text)).toContain('route="system"');
      expect(envelope('notice-id', text)).toContain(text);
      expect(() => sessionDirectMessageId('host:update', sessionId, {
        delivery_id: (options as { receipt: { id: string } }).receipt.id,
        delivery_at: new Date(update.at).toISOString(),
      })).not.toThrow();
    }
    await resumeHostUpdate(['claude'], update, '0.3.1-beta.1129');
    expect(mocks.send.mock.calls[2]?.[3]).toEqual(mocks.send.mock.calls[0]?.[3]);
  });

  it.each([
    { reason: 'restart', at: 100 } as const,
    { reason: 'unclean', at: null } as const,
  ])('does not resume after $reason', async lastExit => {
    await resumeHostUpdate(['session'], lastExit, 'new');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not send anything when no session was settled', async () => {
    await resumeHostUpdate([], update, 'new');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('records a delivery failure per task and still resumes the other task', async () => {
    const failure = new Error('fixture delivery refusal');
    mocks.send.mockRejectedValueOnce(failure);
    await expect(resumeHostUpdate(['broken', 'other'], update, 'new')).resolves.toBeUndefined();
    expect(mocks.send.mock.calls.map(call => call[1])).toEqual(['broken', 'other']);
    expect(sessionBootTasks.snapshot()).toEqual([
      { operation: 'update-resume', taskId: 'broken', message: failure.message },
    ]);
  });
});
