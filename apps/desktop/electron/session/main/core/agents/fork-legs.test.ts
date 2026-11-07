import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';

const emit = vi.hoisted(() => vi.fn());
const kept = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@main/lib/events', () => ({ events: { emit, on: vi.fn(() => () => {}) } }));
vi.mock('@main/db/kv', () => ({
  KV: class {
    set = async (key: string, value: unknown) => void kept.set(key, value);
    getAll = async () => Object.fromEntries(kept);
  },
}));

import { forkRuntimes, loadAcpForkHandshakes, recordAcpForkHandshake, resetAcpForkHandshakesForTest } from './fork-legs';

const legs = (id: string) => forkRuntimes(pluginRegistry.get(id)!);

describe('fork legs: one rule for every fork entry', () => {
  afterEach(() => {
    resetAcpForkHandshakesForTest();
    kept.clear();
    emit.mockClear();
  });

  it('pi: the CLI --fork proves the pty leg only; pi-acp never handshaken ⇒ no ACP fork (no side chat)', () => {
    expect(legs('pi')).toEqual(['pty']);
  });

  it('pi: an adapter handshake that reports fork adds the ACP leg; one that does not keeps it off', () => {
    recordAcpForkHandshake('pi', false);
    expect(legs('pi')).toEqual(['pty']);
    recordAcpForkHandshake('pi', true);
    expect(legs('pi')).toEqual(['pty', 'acp']);
    // Only a changed reading tells renderers to re-read agents.
    recordAcpForkHandshake('pi', true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('a restart keeps the last reading: no adapter needs to run again before the entry is offered', async () => {
    recordAcpForkHandshake('pi', true);
    recordAcpForkHandshake('codex', false);
    resetAcpForkHandshakesForTest(); // the process ended
    expect(legs('pi')).toEqual(['pty']);
    await loadAcpForkHandshakes();
    expect(legs('pi')).toEqual(['pty', 'acp']);
    expect(legs('codex')).toEqual(['pty']);
    // A later connection corrects it.
    recordAcpForkHandshake('pi', false);
    expect(legs('pi')).toEqual(['pty']);
  });

  it('a provider-owned ACP fork hook decides over the handshake', () => {
    for (const id of ['claude', 'opencode', 'antigravity']) {
      recordAcpForkHandshake(id, false);
      expect(legs(id), id).toContain('acp');
    }
  });

  it('codex / oh-my-pi fork on ACP through the adapter handshake alone', () => {
    expect(legs('codex')).toEqual(['pty']);
    recordAcpForkHandshake('codex', true);
    expect(legs('codex')).toEqual(['pty', 'acp']);
  });
});
