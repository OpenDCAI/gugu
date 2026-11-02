import { afterEach, describe, expect, it, vi } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';

const emit = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/events', () => ({ events: { emit, on: vi.fn(() => () => {}) } }));

import { forkRuntimes, recordAcpForkHandshake, resetAcpForkHandshakesForTest } from './fork-legs';

const legs = (id: string) => forkRuntimes(pluginRegistry.get(id)!);

describe('fork legs: one rule for every fork entry', () => {
  afterEach(() => {
    resetAcpForkHandshakesForTest();
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
