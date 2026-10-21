import type { TerminalState } from '@gugu/session-core/acp';
import { LiveLog } from '@gugu/session-wire';
import type { AgentTerminalHooks } from '../agent-ports/terminal-manager';

type TerminalRecord = {
  sessionId: string;
  state: TerminalState;
  log: LiveLog;
};

/**
 * Mirrors terminal hook callbacks into live primitives.
 *
 * Terminal metadata/status is exposed as one LiveModel per conversation.
 * Terminal output is exposed as one LiveLog per terminal and should be treated
 * as the authoritative output stream by clients.
 */
export class TerminalLiveRegistry {
  private readonly byTerminal = new Map<string, TerminalRecord>();
  private readonly bySession = new Map<string, Set<string>>();

  constructor(private readonly onSessionChanged?: (sessionId: string) => void) {}

  readonly hooks: AgentTerminalHooks = {
    onTerminalCreated: ({ sessionId, terminalId, command, args, cwd }) => {
      const record: TerminalRecord = {
        sessionId,
        state: {
          terminalId,
          command,
          args,
          cwd,
          output: '',
          truncated: false,
          exitStatus: null,
        },
        log: new LiveLog(),
      };
      this.byTerminal.set(terminalId, record);
      this.addToSession(sessionId, terminalId);
      this.onSessionChanged?.(sessionId);
    },
    onTerminalOutput: ({ sessionId, terminalId, chunk, truncated }) => {
      const record = this.byTerminal.get(terminalId);
      if (!record) return;
      record.log.append(chunk);
      record.state = {
        ...record.state,
        output: `${record.state.output}${chunk}`,
        truncated,
      };
      this.byTerminal.set(terminalId, record);
      this.onSessionChanged?.(sessionId);
    },
    onTerminalExit: ({ sessionId, terminalId, exitStatus }) => {
      const record = this.byTerminal.get(terminalId);
      if (!record) return;
      record.state = { ...record.state, exitStatus };
      this.byTerminal.set(terminalId, record);
      this.onSessionChanged?.(sessionId);
    },
    onTerminalReleased: ({ sessionId, terminalId }) => {
      this.byTerminal.delete(terminalId);
      const ids = this.bySession.get(sessionId);
      ids?.delete(terminalId);
      if (ids?.size === 0) this.bySession.delete(sessionId);
      this.onSessionChanged?.(sessionId);
    },
  };

  getTerminalLog(terminalId: string): LiveLog | null {
    return this.byTerminal.get(terminalId)?.log ?? null;
  }

  private addToSession(sessionId: string, terminalId: string): void {
    let ids = this.bySession.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.bySession.set(sessionId, ids);
    }
    ids.add(terminalId);
  }

  snapshotSession(sessionId: string): TerminalState[] {
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    return [...ids].flatMap((terminalId) => {
      const record = this.byTerminal.get(terminalId);
      return record ? [record.state] : [];
    });
  }
}
