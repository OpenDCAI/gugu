import { describe, expect, it, vi } from 'vitest';

import type { AcpRuntimeStartInput } from '@gugu/session-core/acp';
import { resumeHistoryFacts } from './resume-history';

vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const input = (patch: Partial<AcpRuntimeStartInput> = {}) => ({
  sessionId: 's1', projectId: 'p', providerId: 'codex', workspaceId: 'w', cwd: '/w',
  providerSessionId: 'thread-1', model: null, ...patch,
}) as AcpRuntimeStartInput;

describe('resuming without replay (#980)', () => {
  it.each(['claude', 'codex', 'hermes'])('%s resumes without replay, continuing turn numbers after the stored ones', async (providerId) => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input({ providerId }), {
      recordedDeliveryIds,
      fillFromRecord: async () => undefined, turnIndexBase: async () => 12,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: ['msg:a'], turnIndexBase: 12 });
    expect(recordedDeliveryIds).toHaveBeenCalledWith('s1');
  });

  it('fills the store from the record before counting where turn numbers continue', async () => {
    const order: string[] = [];
    await resumeHistoryFacts(input(), {
      recordedDeliveryIds: async () => [],
      fillFromRecord: async () => { order.push('fill'); },
      turnIndexBase: async () => { order.push('base'); return 0; },
    });
    expect(order).toEqual(['fill', 'base']);
  });

  it('starts anyway when filling from the record fails', async () => {
    const facts = await resumeHistoryFacts(input(), {
      recordedDeliveryIds: async () => [],
      fillFromRecord: async () => { throw new Error('record unreadable'); },
      turnIndexBase: async () => 4,
    });
    expect(facts).toEqual({ replayHistory: false, recordedDeliveryIds: [], turnIndexBase: 4 });
  });

  it('always reads the record for deliveries: a reconnecting runtime redelivers from a queue the host cannot see', async () => {
    const recordedDeliveryIds = vi.fn(async () => ['msg:a']);
    const facts = await resumeHistoryFacts(input({ initialQueue: [{ text: 'hi', origin: 'manual' }] }), {
      recordedDeliveryIds,
      fillFromRecord: async () => undefined, turnIndexBase: async () => 0,
    });
    expect(facts.recordedDeliveryIds).toEqual(['msg:a']);
    expect(recordedDeliveryIds).toHaveBeenCalledWith('s1');
  });

  it.each(['claude', 'codex', 'hermes'])('%s resumes with replay when the record cannot be read', async (providerId) => {
    const facts = await resumeHistoryFacts(input({ providerId }), { recordedDeliveryIds: async () => null, fillFromRecord: async () => undefined, turnIndexBase: async () => 0 });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it.each(['claude', 'codex', 'hermes'])('%s resumes with replay when it cannot tell where turn numbers continue', async (providerId) => {
    const facts = await resumeHistoryFacts(input({ providerId }), {
      recordedDeliveryIds: async () => [], fillFromRecord: async () => undefined,
      turnIndexBase: async () => { throw new Error('store unreadable'); },
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });

  it.each([
    ['a provider whose record gugu cannot read', { providerId: 'gemini' }],
    ['a provider gugu reads but whose adapter still replays', { providerId: 'qwen' }],
    ['a session that never opened a provider session', { providerSessionId: null }],
    ['a runtime fork', { forkFromProviderSessionId: 'thread-0' }],
  ])('keeps the replay for %s and overwrites renderer-sent values', async (_label, patch) => {
    const facts = await resumeHistoryFacts(input({ ...patch, replayHistory: false } as Partial<AcpRuntimeStartInput>), {
      recordedDeliveryIds: async () => [], fillFromRecord: async () => undefined, turnIndexBase: async () => 3,
    });
    expect(facts).toEqual({ replayHistory: undefined, recordedDeliveryIds: undefined, turnIndexBase: undefined });
  });
});
