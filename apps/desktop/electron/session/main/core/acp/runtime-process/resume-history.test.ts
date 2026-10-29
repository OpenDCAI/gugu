import { describe, expect, it, vi } from 'vitest';

import type { AcpRuntimeStartInput } from '@gugu/session-core/acp';
import { resumeHistoryFacts } from './resume-history';

const input = (patch: Partial<AcpRuntimeStartInput> = {}) => ({
  sessionId: 's1', projectId: 'p', providerId: 'codex', workspaceId: 'w', cwd: '/w',
  providerSessionId: 'thread-1', model: null, ...patch,
}) as AcpRuntimeStartInput;

describe('resuming without replay (#980)', () => {
  it('turns replay off for a provider whose record gugu reads, continuing turn numbers after the stored ones', async () => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input(), {
      storedQueue: async () => [{ origin: 'communication' }],
      recordedDeliveryIds,
      fillFromRecord: async () => undefined, turnIndexBase: async () => 12,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: ['msg:a'], turnIndexBase: 12 });
    expect(recordedDeliveryIds).toHaveBeenCalledWith('s1');
  });

  it('fills the store from the record before counting where turn numbers continue', async () => {
    const order: string[] = [];
    await resumeHistoryFacts(input(), {
      storedQueue: async () => [],
      recordedDeliveryIds: async () => [],
      fillFromRecord: async () => { order.push('fill'); },
      turnIndexBase: async () => { order.push('base'); return 0; },
    });
    expect(order).toEqual(['fill', 'base']);
  });

  it('starts anyway when filling from the record fails', async () => {
    const facts = await resumeHistoryFacts(input(), {
      storedQueue: async () => [],
      recordedDeliveryIds: async () => [],
      fillFromRecord: async () => { throw new Error('record unreadable'); },
      turnIndexBase: async () => 4,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: [], turnIndexBase: 4 });
  });

  it('reads the record for deliveries only when a delivery is waiting to be redelivered', async () => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input({ initialQueue: [{ text: 'hi', origin: 'manual' }] }), {
      storedQueue: async () => [],
      recordedDeliveryIds,
      fillFromRecord: async () => undefined, turnIndexBase: async () => 0,
    });
    expect(facts.recordedDeliveryIds).toEqual([]);
    expect(recordedDeliveryIds).not.toHaveBeenCalled();
  });

  it('reads the record when the stored queue cannot be read, rather than assume nothing waits', async () => {
    const recordedDeliveryIds = vi.fn(async () => null);
    const facts = await resumeHistoryFacts(input(), { storedQueue: async () => null, recordedDeliveryIds, fillFromRecord: async () => undefined, turnIndexBase: async () => 0 });
    expect(facts).toMatchObject({ replayHistory: false, recordedDeliveryIds: null });
  });

  it('resumes with replay when it cannot tell where turn numbers continue', async () => {
    const facts = await resumeHistoryFacts(input(), {
      storedQueue: async () => [], recordedDeliveryIds: async () => [], fillFromRecord: async () => undefined,
      turnIndexBase: async () => { throw new Error('store unreadable'); },
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it.each([
    ['a provider whose record gugu cannot read', { providerId: 'gemini' }],
    ['a session that never opened a provider session', { providerSessionId: null }],
    ['a runtime fork', { forkFromProviderSessionId: 'thread-0' }],
  ])('keeps the replay for %s and overwrites renderer-sent values', async (_label, patch) => {
    const facts = await resumeHistoryFacts(input({ ...patch, replayHistory: false } as Partial<AcpRuntimeStartInput>), {
      storedQueue: async () => [], recordedDeliveryIds: async () => [], fillFromRecord: async () => undefined, turnIndexBase: async () => 3,
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });
});
