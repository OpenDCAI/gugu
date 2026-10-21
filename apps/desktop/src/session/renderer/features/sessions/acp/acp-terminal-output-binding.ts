import type { TerminalExit } from '@gugu/session-core/acp/client';

type TerminalOutputBinding = {
  text(): string;
  onAppend(listener: () => void): () => void;
};

/**
 * The runtime publishes a whole `TerminalState` per live terminal; this binding
 * needs two of its fields. The id addresses the output log, and `exitStatus` is
 * how the command ended — a first-hand reading, because the client is what
 * spawned the process for `terminal/create`.
 */
type TerminalSnapshot = {
  terminalId: string;
  exitStatus?: TerminalExit | null;
};

type TerminalOutputSession = {
  terminals: {
    current(): ReadonlyArray<TerminalSnapshot>;
    onChange(listener: () => void): () => void;
  };
  terminalOutput(terminalId: string): Promise<TerminalOutputBinding>;
};

export function bindSessionTerminalOutputs(
  session: TerminalOutputSession,
  setTerminalOutput: (terminalId: string, text: string | null) => void,
  setTerminalExitStatus: (terminalId: string, exitStatus: TerminalExit) => void
): () => void {
  const terminalUnsubs = new Map<string, () => void>();
  let disposed = false;

  const removeTerminal = (terminalId: string): void => {
    terminalUnsubs.get(terminalId)?.();
    terminalUnsubs.delete(terminalId);
  };

  const syncTerminals = (): void => {
    if (disposed) return;
    const terminals = session.terminals.current();

    // Read the exit status off every terminal still listed, on every change.
    // The window to catch it is narrow: the runtime publishes the exit as its
    // own update and then the agent releases the terminal, after which it is
    // gone from this list for good. Whoever receives it latches it, so seeing
    // it once is enough and seeing it repeatedly costs nothing.
    for (const terminal of terminals) {
      if (terminal.exitStatus) setTerminalExitStatus(terminal.terminalId, terminal.exitStatus);
    }

    const nextIds = new Set(terminals.map((terminal) => terminal.terminalId));

    for (const terminalId of Array.from(terminalUnsubs.keys())) {
      if (!nextIds.has(terminalId)) removeTerminal(terminalId);
    }

    for (const terminalId of nextIds) {
      if (terminalUnsubs.has(terminalId)) continue;

      let unsubscribeLog: (() => void) | undefined;
      let active = true;
      terminalUnsubs.set(terminalId, () => {
        active = false;
        unsubscribeLog?.();
        setTerminalOutput(terminalId, null);
      });

      void session
        .terminalOutput(terminalId)
        .then((binding) => {
          if (disposed || !active) return;
          const syncOutput = (): void => setTerminalOutput(terminalId, binding.text());
          syncOutput();
          unsubscribeLog = binding.onAppend(syncOutput);
        })
        .catch(() => {
          if (active) setTerminalOutput(terminalId, null);
        });
    }
  };

  syncTerminals();
  const unsubscribeTerminals = session.terminals.onChange(syncTerminals);
  return () => {
    disposed = true;
    unsubscribeTerminals();
    for (const terminalId of Array.from(terminalUnsubs.keys())) {
      removeTerminal(terminalId);
    }
  };
}
