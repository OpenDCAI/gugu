import { describe, expect, it } from 'vitest';
import {
  acpApiContract,
  acpRuntimeApiContract,
  TERMINAL_CHUNK_CAPABILITY,
  terminalPresentation,
  type TerminalState,
} from '@gugu/session-core/acp';
import { connect, serve, type Controller } from '@gugu/session-wire/api';
import { memoryTransportPair } from '@gugu/session-wire/api';
import { LiveState } from '../../../../../../../../packages/session-wire/src/live/state/server';
import { withTerminalOutputNegotiation } from './terminal-output-negotiation';

const terminal: TerminalState = {
  terminalId: 't',
  owner: 'agent',
  canKill: false,
  command: '',
  args: [],
  cwd: '',
  output: 'legacy tail',
  truncated: true,
  exitStatus: null,
};
const legacyId = acpApiContract.session.states.terminals.id;
const chunkedId = acpRuntimeApiContract.session.states.terminalChunks.id;
const topic = legacyId + '|{"sessionId":"s"}';

describe('terminal output capability handshake', () => {
  for (const supportsChunks of [false, true])
    it(`new host serves ${supportsChunks ? 'declared chunks' : 'legacy strings'} without changing the protocol`, async () => {
      const legacy = new LiveState([terminal]);
      const chunked = new LiveState<TerminalState[]>([
        { ...terminal, output: '', outputChunks: { '10': 'chunk tail' } },
      ]);
      const base: Controller = {
        call: async () => {
          throw new Error('unused');
        },
        resolveLive: (topic) => {
          const model = topic.startsWith(legacyId + '|')
            ? legacy
            : topic.startsWith(chunkedId + '|')
              ? chunked
              : null;
          return (
            model && { snapshot: () => model.snapshot(), subscribe: (cb) => model.subscribe(cb) }
          );
        },
      };
      const { left: clientPort, right: serverPort } = memoryTransportPair();
      const stop = serve(serverPort, withTerminalOutputNegotiation(base));
      const connection = connect(
        clientPort,
        supportsChunks ? { capabilities: [TERMINAL_CHUNK_CAPABILITY] } : {},
      );
      try {
        const snapshot = await connection.snapshot(topic);
        const first = (snapshot.data as TerminalState[])[0]!;
        expect(first.outputChunks !== undefined).toBe(supportsChunks);
        expect(terminalPresentation(first).output).toBe(
          supportsChunks ? 'chunk tail' : 'legacy tail',
        );
        const updates: unknown[] = [];
        const detach = await connection.attach(topic, (update) => updates.push(update));
        legacy.produce((draft) => {
          draft[0]!.output = 'old format update';
        });
        chunked.produce((draft) => {
          draft[0]!.outputChunks!['11'] = '!';
        });
        await Promise.resolve();
        expect(updates).toHaveLength(1);
        detach();
        if (!supportsChunks)
          await expect(connection.snapshot(chunkedId + '|{"sessionId":"s"}')).rejects.toMatchObject(
            { code: 'UNKNOWN_TOPIC' },
          );
      } finally {
        stop();
        clientPort.close?.();
        serverPort.close?.();
      }
    });

  it('a new client continues reading an old host that ignores optional capabilities', async () => {
    const { left: clientPort, right: serverPort } = memoryTransportPair();
    const stop = serve(serverPort, {
      call: async () => {
        throw new Error('unused');
      },
      // The old host neither reads the declaration nor exposes a chunked state.
      resolveLive: (requested) =>
        requested === topic
          ? {
              snapshot: () => ({ generation: 1, sequence: 0, timestamp: 0, data: [terminal] }),
              subscribe: () => () => {},
            }
          : null,
    });
    try {
      const connection = connect(clientPort, { capabilities: [TERMINAL_CHUNK_CAPABILITY] });
      const result = await connection.snapshot(topic);
      expect(terminalPresentation((result.data as TerminalState[])[0]!).output).toBe('legacy tail');
    } finally {
      stop();
      clientPort.close?.();
      serverPort.close?.();
    }
  });
});
