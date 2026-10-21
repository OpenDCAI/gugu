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

class FakeLog {
  private listeners = new Set<() => void>();

  constructor(private value: string) {}

  text(): string {
    return this.value;
  }

  onAppend(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: string): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
}

describe('bindSessionTerminalOutputs', () => {
  it('mirrors terminal log text and clears it on terminal removal', async () => {
    const terminals = new FakeLiveList([{ terminalId: 'term-1' }]);
    const log = new FakeLog('initial output');
    const terminalOutput = vi.fn(async () => log);
    const outputs = new Map<string, string | null>();

    const dispose = bindSessionTerminalOutputs(
      { terminals, terminalOutput },
      (terminalId, text) => outputs.set(terminalId, text),
      () => {}
    );
    await flushPromises();

    expect(terminalOutput).toHaveBeenCalledWith('term-1');
    expect(outputs.get('term-1')).toBe('initial output');

    log.set('live output');
    expect(outputs.get('term-1')).toBe('live output');

    terminals.set([]);
    expect(outputs.get('term-1')).toBeNull();

    log.set('late output');
    expect(outputs.get('term-1')).toBeNull();

    dispose();
  });

  it('clears mirrored outputs when disposed', async () => {
    const terminals = new FakeLiveList([{ terminalId: 'term-1' }]);
    const log = new FakeLog('initial output');
    const outputs = new Map<string, string | null>();

    const dispose = bindSessionTerminalOutputs(
      { terminals, terminalOutput: async () => log },
      (terminalId, text) => outputs.set(terminalId, text),
      () => {}
    );
    await flushPromises();

    dispose();
    expect(outputs.get('term-1')).toBeNull();

    log.set('late output');
    expect(outputs.get('term-1')).toBeNull();
  });

  // The exit lands as its own live update and the release follows it, so the
  // reading has to be taken from the list while the terminal is still on it —
  // and it has to survive the removal, unlike the output next to it.
  it('reports the exit status while the terminal is still listed, and never retracts it', async () => {
    const terminals = new FakeLiveList<
      { terminalId: string; exitStatus?: { exitCode: number | null; signal: string | null } | null }[]
    >([{ terminalId: 'term-1' }]);
    const log = new FakeLog('build output');
    const exits: [string, unknown][] = [];

    const dispose = bindSessionTerminalOutputs(
      { terminals, terminalOutput: async () => log },
      () => {},
      (terminalId, exitStatus) => exits.push([terminalId, exitStatus])
    );
    await flushPromises();

    expect(exits).toEqual([]);

    terminals.set([{ terminalId: 'term-1', exitStatus: { exitCode: 1, signal: null } }]);
    expect(exits).toEqual([['term-1', { exitCode: 1, signal: null }]]);

    // Release. The output binding clears; the exit reading is never withdrawn,
    // because nothing here is able to say "that process did not exit after all".
    terminals.set([]);
    expect(exits).toEqual([['term-1', { exitCode: 1, signal: null }]]);

    dispose();
  });

  it('leaves the exit status unreported while the command is still running', async () => {
    const terminals = new FakeLiveList([{ terminalId: 'term-1', exitStatus: null }]);
    const log = new FakeLog('');
    const exits: [string, unknown][] = [];

    const dispose = bindSessionTerminalOutputs(
      { terminals, terminalOutput: async () => log },
      () => {},
      (terminalId, exitStatus) => exits.push([terminalId, exitStatus])
    );
    await flushPromises();

    log.set('still going');
    expect(exits).toEqual([]);

    dispose();
  });
});
