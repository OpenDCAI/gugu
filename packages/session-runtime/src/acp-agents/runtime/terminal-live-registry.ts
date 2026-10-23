import { terminalEntityId, patchEntityMeta, type NormalizedEvent, type TerminalState } from '@gugu/session-core/acp';
import type { AgentTerminalHooks } from '../agent-ports/terminal-manager';

type TerminalRecord = {
  state: Omit<TerminalState, 'output'>;
  bytes: Buffer;
};

/** Session-owned presentation, independent of tool references and process handles.
 * This is live state, not an archive: the existing native records own cold replay.
 */
export class TerminalLiveRegistry {
  private readonly bySession = new Map<string, Map<string, TerminalRecord>>();

  constructor(private readonly onSessionChanged?: (sessionId: string) => void) {}

  readonly hooks: AgentTerminalHooks = {
    onTerminalCreated: ({ sessionId, scope, snapshot }) => this.hostSnapshot(sessionId, scope, snapshot),
    onTerminalOutput: ({ sessionId, scope, snapshot }) => this.hostSnapshot(sessionId, scope, snapshot),
    onTerminalExit: ({ sessionId, scope, snapshot }) => this.hostSnapshot(sessionId, scope, snapshot),
    onTerminalReleased: ({ sessionId, scope, terminalId }) => {
      const record = this.bySession.get(sessionId)?.get(terminalEntityId(scope, terminalId));
      if (!record) return;
      record.state = { ...record.state, canKill: false };
      this.onSessionChanged?.(sessionId);
    },
  };

  private hostSnapshot(sessionId: string, scope: string, snapshot: TerminalState): void {
    const { output, ...state } = snapshot;
    this.session(sessionId).set(terminalEntityId(scope, state.terminalId), {
      state: { ...state, terminalId: terminalEntityId(scope, state.terminalId) },
      bytes: Buffer.from(output, 'utf8'),
    });
    this.onSessionChanged?.(sessionId);
  }

  accept(sessionId: string, scope: string, event: Extract<NormalizedEvent, { kind: 'terminal_update' | 'terminal_chunk' }>): void {
    const terminalId = terminalEntityId(scope, event.terminal.terminalId);
    const session = this.session(sessionId);
    const record = session.get(terminalId) ?? {
      state: { terminalId, owner: 'agent' as const, canKill: false, command: '', args: [], cwd: '', truncated: false, exitStatus: null },
      bytes: Buffer.alloc(0),
    };
    if (record.state.owner !== 'agent') throw new Error('Agent update targets a host-owned terminal');
    if (event.kind === 'terminal_chunk') {
      record.bytes = Buffer.concat([record.bytes, Buffer.from(event.terminal.data, 'base64')]);
    } else {
      const update = event.terminal;
      for (const key of ['command', 'cwd'] as const) {
        if (update[key] !== undefined) record.state = { ...record.state, [key]: update[key] ?? '' };
      }
      if (update.output !== undefined) record.bytes = Buffer.from(update.output?.data ?? '', 'base64');
      if (update.exitStatus !== undefined) record.state = { ...record.state, exitStatus: update.exitStatus === null ? null : {
        exitCode: update.exitStatus.exitCode ?? null, signal: update.exitStatus.signal ?? null,
      } };
      record.state = { ...record.state, _meta: patchEntityMeta(record.state._meta, update._meta) };
    }
    session.set(terminalId, record);
    this.onSessionChanged?.(sessionId);
  }

  private session(sessionId: string): Map<string, TerminalRecord> {
    let session = this.bySession.get(sessionId);
    if (!session) this.bySession.set(sessionId, (session = new Map()));
    return session;
  }

  snapshotSession(sessionId: string): TerminalState[] {
    return [...(this.bySession.get(sessionId)?.values() ?? [])].map(({ state, bytes }) => ({
      ...state,
      // Incomplete trailing UTF-8 stays invisible until another chunk or exit arrives.
      output: new TextDecoder().decode(bytes, { stream: state.exitStatus === null }),
    }));
  }

  disposeSession(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  route(sessionId: string, connectionKey: string, providerSessionId: string, event: NormalizedEvent): NormalizedEvent | null {
    const scope = JSON.stringify([connectionKey, providerSessionId]);
    if (event.kind === 'terminal_update' || event.kind === 'terminal_chunk') {
      this.accept(sessionId, scope, event);
      return null;
    }
    if (event.kind === 'subagent_stream') {
      const inner = this.route(sessionId, connectionKey, event.subagentSessionId, event.event);
      return inner ? { ...event, event: inner } : null;
    }
    if (event.kind !== 'tool_call' && event.kind !== 'tool_update') return event;
    const content = event.contentBlocks?.map(block =>
      block.type === 'terminal' && typeof block.terminalId === 'string'
        ? { ...block, terminalId: terminalEntityId(scope, block.terminalId) } : block) ?? null;
    const fields = event.contentBlocks !== undefined ? { contentBlocks: content } : {};
    if (event.kind === 'tool_call') return { ...event, ...fields,
      ...(event.terminalId !== undefined ? { terminalId: terminalEntityId(scope, event.terminalId) } : {}),
    };
    return { ...event, ...fields,
      ...(event.terminalId !== undefined ? { terminalId: event.terminalId === null ? null : terminalEntityId(scope, event.terminalId) } : {}),
    };
  }

}
