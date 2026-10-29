import type { TerminalState } from '@gugu/session-core/acp/client';

type TerminalSession = {
  terminals: {
    current(): readonly TerminalState[];
    onChange(listener: () => void): () => void;
  };
};

/** One whole snapshot hydrates output and exit together, including late subscribers. */
export function bindSessionTerminalOutputs(
  session: TerminalSession,
  setTerminals: (terminals: readonly TerminalState[]) => void
): () => void {
  const sync = () => setTerminals(session.terminals.current());
  sync();
  return session.terminals.onChange(sync);
}
