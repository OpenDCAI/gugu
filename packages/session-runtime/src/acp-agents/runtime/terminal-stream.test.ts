import { describe, expect, it, vi } from 'vitest';
import {
  LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT,
  TERMINAL_OUTPUT_BYTE_LIMIT,
  terminalPresentation,
  type TerminalState,
} from '@gugu/session-core/acp';
import { LiveState } from '../../../../session-wire/src/live/state/server';
import { publishLiveModelState } from '../state/live-models';
import { TerminalLiveRegistry } from './terminal-live-registry';

const send = (registry: TerminalLiveRegistry, data: string) =>
  registry.accept('s', 'scope', {
    kind: 'terminal_chunk',
    terminal: { terminalId: 't', data },
  });

describe('bounded terminal streaming', () => {
  it('bounds the combined live bytes of many terminals and keeps only byte counts for evicted output', () => {
    const registry = new TerminalLiveRegistry();
    const chunk = Buffer.alloc(1024 * 1024, 65).toString('base64');
    for (let n = 0; n < 10; n++) registry.accept('s', 'scope', {
      kind: 'terminal_chunk', terminal: { terminalId: String(n), data: chunk },
    });
    const states = registry.snapshotSession('s', true);
    expect(states.reduce((sum, state) => sum + Buffer.byteLength(terminalPresentation(state).output), 0)).toBe(TERMINAL_OUTPUT_BYTE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(states))).toBeLessThan(5 * 1024 * 1024);
    expect(states[0]).toMatchObject({ truncated: true, outputBytes: 1024 * 1024 });
    expect(terminalPresentation(states[0]).output).toBe('');
    expect(states.every(state => state.outputBytes === 1024 * 1024)).toBe(true);
  });

  it('counts all 25 MiB, sends bounded incremental chunks, and preserves the tail when completion is truncated', () => {
    const registry = new TerminalLiveRegistry();
    const live = new LiveState<TerminalState[]>([]);
    let wireBytes = 0;
    live.subscribe((update) => {
      wireBytes += Buffer.byteLength(JSON.stringify(update));
    });
    const chunk = Buffer.alloc(16 * 1024, 65);
    let previous: TerminalState[] | undefined;
    for (let n = 0; n < 1600; n++) {
      send(registry, chunk.toString('base64'));
      if (n === 10) registry.accept('s', 'scope', {
        kind: 'terminal_update',
        terminal: { terminalId: 't', output: { data: '' } },
      });
      // The same publisher and patch implementation used by the worker.
      if (n % 32 === 31) {
        const next = registry.snapshotSession('s', true);
        publishLiveModelState(live, next, previous);
        previous = next;
      }
    }
    registry.accept('s', 'scope', {
      kind: 'terminal_update',
      terminal: {
        terminalId: 't',
        output: { data: Buffer.from('provider summary').toString('base64') },
        exitStatus: { exitCode: 0 },
      },
    });
    const terminal = registry.snapshotSession('s')[0]!;
    expect(terminal).toMatchObject({
      truncated: true,
      outputBytes: 25 * 1024 * 1024,
      exitStatus: { exitCode: 0 },
    });
    expect(Buffer.byteLength(terminal.output)).toBe(TERMINAL_OUTPUT_BYTE_LIMIT);
    expect(terminal.output).not.toContain('provider summary');
    const legacy = registry.snapshotSession('s', 'legacy')[0]!;
    expect(legacy.truncated).toBe(true);
    expect(legacy.outputChunks).toBeUndefined();
    expect(Buffer.byteLength(legacy.output)).toBeLessThanOrEqual(
      LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT,
    );
    expect(wireBytes).toBeLessThan(2 * 25 * 1024 * 1024);
    expect(terminalPresentation(live.snapshot().data[0]!).output).toBe(terminal.output);
  });

  it('copies linearly as input doubles, rather than recopying all preceding bytes on each append', () => {
    const data = Buffer.alloc(4096, 65).toString('base64');
    const run = (count: number) => {
      const registry = new TerminalLiveRegistry();
      const from = vi.spyOn(Buffer, 'from');
      const concat = vi.spyOn(Buffer, 'concat');
      try {
        for (let n = 0; n < count; n++) send(registry, data);
        const copied = [...from.mock.results, ...concat.mock.results].reduce(
          (sum, result) =>
            sum +
            (result.type === 'return' && Buffer.isBuffer(result.value) ? result.value.length : 0),
          0,
        );
        expect(registry.snapshotSession('s')[0]!.output.length).toBe(count * 4096);
        return copied;
      } finally {
        from.mockRestore();
        concat.mockRestore();
      }
    };
    const one = run(128);
    const two = run(256);
    expect(one).toBeGreaterThanOrEqual(128 * 4096);
    expect(two).toBeLessThanOrEqual(one * 2.1);
    expect(two).toBeLessThanOrEqual(256 * 4096 * 3);
  });
});
