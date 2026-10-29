import { decodeSessionUpdate } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';
import { ASSISTANT_IDLE_COMPACT_MS } from './idle-compaction';
import { sessionOpenMeta } from './session-manager';

afterEach(() => vi.useRealTimers());

describe('assistant maintenance host wiring', () => {
  it.each([true, false])('opts in only a prepared assistant (enabled=%s), and skips ordinary turn-end continuation', async (enabled) => {
    const h = makeAcpHarness();
    const provider = h.deps.agentHost.resolveAcp('claude')!;
    const ended = vi.fn(async () => ({ continueWith: 'must not run after maintenance' }));
    provider.behavior.onTurnEnded = ended;
    const rt = new AcpRuntime(h.deps);
    try {
      const input = makeStartInput({ sessionMeta: enabled ? { guguAssistant: { idleCompaction: true } } : undefined });
      expect((await rt.startSession(input)).success).toBe(true);
      vi.useFakeTimers();
      await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
        sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact', input: null }],
      } as SessionUpdate) });
      await h.client().sessionEvent({ sessionId: 'session-1', event: decodeSessionUpdate({
        sessionUpdate: 'usage_update', used: 140_000, size: 1_000_000,
      } as SessionUpdate) });
      // The usage reading reaches the record on the next transcript tick (100 ms); the idle window starts there.
      await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_COMPACT_MS + 100);
      expect(h.agent.prompt).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(ended).not.toHaveBeenCalled();
      if (enabled) expect(JSON.stringify(h.agent.prompt.mock.calls[0])).toContain('/compact');
    } finally {
      vi.useRealTimers();
      await rt.dispose();
    }
  });

  it('does not pass host-only scheduling policy to the adapter', () => {
    expect(sessionOpenMeta(makeStartInput({ sessionMeta: {
      guguAssistant: { idleCompaction: true }, claudeCode: { options: { env: { KEEP: 'yes' } } },
    } }))).toEqual({ _meta: { claudeCode: { options: { env: { KEEP: 'yes' } } } } });
  });
});
