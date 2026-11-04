import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpRuntimeApiContract, type TranscriptTurnOutcome } from '@gugu/session-core/acp';
import { defineContract } from '@gugu/session-wire';
import { createTestWire } from '@gugu/session-wire/testing';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { createAcpProcedures } from '../api/procedures';
import { AcpRuntime } from './runtime';

const runtimes: AcpRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.dispose(); });

async function running(count = 1, admitted = true) {
  const outcomes: Array<TranscriptTurnOutcome | undefined> = [];
  const errors: unknown[][] = [];
  const h = makeAcpHarness({ onTurnCommitted: ({ turn }) => outcomes.push(turn.outcome) });
  h.deps.logger = { ...h.deps.logger, error: (...args: unknown[]) => { errors.push(args); } };
  const rt = new AcpRuntime(h.deps);
  runtimes.push(rt);
  const api = createAcpProcedures(rt);
  const wire = createTestWire(defineContract({
    promptDetached: acpRuntimeApiContract.promptDetached,
    waitPromptDetached: acpRuntimeApiContract.waitPromptDetached,
  }), { promptDetached: api.promptDetached, waitPromptDetached: api.waitPromptDetached }, { validate: 'full' });
  const rejects: Array<(error: unknown) => void> = [];
  const finishes: Array<() => void> = [];
  h.agent.prompt.mockImplementation(() => new Promise((resolve, reject) => {
    rejects.push(reject); finishes.push(() => resolve({ stopReason: 'end_turn' }));
  }));
  const waits: Array<Promise<unknown>> = [];
  for (let i = 0; i < count; i++) {
    const sessionId = `planned-${i}`;
    expect((await rt.startSession(makeStartInput({ sessionId }))).success).toBe(true);
    const receipt = wire.client.promptDetached({ sessionId, prompt: { text: 'work' } });
    await h.agent.called('prompt', i + 1);
    if (admitted) {
      h.client().sessionEvent({ sessionId: 'session-1', event: { kind: 'thinking', messageId: `start-${i}`, text: 'Working' } });
      const accepted = await receipt;
      waits.push(wire.client.waitPromptDetached({ requestId: accepted.requestId }).then(value => value, error => error));
    } else waits.push(receipt.then(value => value, error => error));
  }
  return { h, rt, wire, waits, outcomes, errors, finish: () => finishes.forEach(finish => finish()), reject: (error: unknown) => rejects.forEach(reject => reject(error)) };
}

describe('planned ACP stop completes owned RPCs as cancellation', () => {
  it.each([1, 24])('settles %i admitted requests once through the real wire', async count => {
    const s = await running(count);
    try {
      for (let i = 0; i < count; i++) expect((await s.rt.stopSession(`planned-${i}`)).success).toBe(true);
      s.reject(new Error('SDK transport ended'));
      const results = await Promise.all(s.waits);
      expect(results).toHaveLength(count);
      for (const result of results) expect(result).toMatchObject({ name: 'WireError', code: 'CANCELLED' });
      expect(s.outcomes).toHaveLength(count);
      expect(s.outcomes.every(outcome => outcome?.kind === 'cancelled')).toBe(true);
    } finally { s.wire.dispose(); }
  });

  it('returns cancellation if stop wins before native admission', async () => {
    const s = await running(1, false);
    try {
      await s.rt.stopSession('planned-0');
      s.reject(new Error('SDK transport ended'));
      expect(await s.waits[0]).toMatchObject({ name: 'WireError', code: 'CANCELLED' });
    } finally { s.wire.dispose(); }
  });

  it('retains stop intent when session/close fails before the adapter exits', async () => {
    const s = await running();
    s.h.agent.closeSession.mockImplementationOnce(async () => {
      s.reject(new Error('SDK transport ended'));
      await Promise.resolve();
      throw new Error('close transport failed');
    });
    try {
      await s.rt.stopSession('planned-0');
      expect(await s.waits[0]).toMatchObject({ code: 'CANCELLED' });
      expect(s.outcomes.at(-1)?.kind).toBe('cancelled');
    } finally { s.wire.dispose(); }
  });

  it.each([-32603, 'CANCELLED'])('keeps provider-authored code %s during stop as a real failure', async code => {
    const s = await running();
    s.h.agent.closeSession.mockImplementationOnce(async () => {
      s.reject(Object.assign(new Error('provider denied this request'), { name: 'RequestError', code }));
      await vi.waitFor(() => expect(s.outcomes.at(-1)?.kind).toBe('error'));
      return {};
    });
    try {
      await s.rt.stopSession('planned-0');
      expect(await s.waits[0]).toMatchObject({ code: 'HANDLER_ERROR', message: expect.stringContaining('provider denied') });
      expect(s.outcomes.at(-1)?.kind).toBe('error');
    } finally { s.wire.dispose(); }
  });

  it('preserves a real successful completion that wins while close is in flight', async () => {
    const s = await running();
    s.h.agent.closeSession.mockImplementationOnce(async () => {
      s.finish();
      await vi.waitFor(() => expect(s.outcomes.at(-1)?.kind).toBe('done'));
      return {};
    });
    try {
      await s.rt.stopSession('planned-0');
      expect(await s.waits[0]).toEqual({ queued: false });
      expect(s.outcomes.at(-1)?.kind).toBe('done');
    } finally { s.wire.dispose(); }
  });

  it('keeps an unexpected adapter crash as a fault with a recorded exit', async () => {
    const s = await running();
    try {
      s.h.lastChild.emitExit(7, null);
      s.reject(new Error('SDK transport ended'));
      expect(await s.waits[0]).toMatchObject({ code: 'HANDLER_ERROR' });
      expect(s.outcomes.at(-1)?.kind).toBe('error');
      expect(s.errors.some(args => args[0] === 'SessionManager: ACP adapter exited; session is lost')).toBe(true);
    } finally { s.wire.dispose(); }
  });
});
