import { describe, expect, it, vi } from 'vitest';
import { bindSessionTerminalOutputs } from './acp-terminal-output-binding';

class FakeLiveList<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  current(): T {
    return this.value;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

import type { TerminalState } from '@gugu/session-core/acp/client';

const snapshot = (output: string, exitStatus: TerminalState['exitStatus'] = null): TerminalState => ({
  terminalId: 't', owner: 'agent', canKill: false, command: 'bash', args: [], cwd: '/w',
  output, exitStatus, truncated: false,
});

describe('bindSessionTerminalOutputs', () => {
  it('hydrates a late subscriber, replaces output and clears nullable exit from one snapshot', () => {
    const terminals = new FakeLiveList([snapshot('old', { exitCode: 0, signal: null })]);
    const set = vi.fn();
    const dispose = bindSessionTerminalOutputs({ terminals }, set);
    expect(set).toHaveBeenLastCalledWith(terminals.current());
    terminals.set([snapshot('x')]);
    expect(set).toHaveBeenLastCalledWith([snapshot('x')]);
    terminals.set([]);
    expect(set).toHaveBeenLastCalledWith([]);
    dispose();
    set.mockClear();
    terminals.set([snapshot('late')]);
    expect(set).not.toHaveBeenCalled();
  });
});
