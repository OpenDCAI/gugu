import { LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT, terminalEntityId, patchEntityMeta, type NormalizedEvent, type TerminalState } from '@gugu/session-core/acp';
import type { AgentTerminalHooks } from '../agent-ports/terminal-manager';
import { TerminalOutput, type TerminalOutputArchive } from './terminal-output';

type TerminalRecord = {
  state: Omit<TerminalState, 'output'>;
  output: TerminalOutput;
  wireSnapshot?: TerminalState;
  legacySnapshot?: TerminalState;
  /**
   * 上一次给出去的那份快照,状态或输出一变就作废(#994)。没变的终端每次给同一个对象:下游按身份就知道它没变,
   * ❌ 每来一次会话更新就把整条会话全部终端的输出重新解码一遍、再逐轮编码比对。
   */
  snapshot?: TerminalState;
};

/** Session-owned presentation, independent of tool references and process handles.
 * This is live state, not an archive: the existing native records own cold replay.
 */
export class TerminalLiveRegistry {
  private readonly bySession = new Map<string, Map<string, TerminalRecord>>();
  /** 每条会话上一次给出去的那一组;其中任一终端变了就作废。 */
  private readonly snapshots = new Map<string, TerminalState[]>();
  private readonly wireSnapshots = new Map<string, TerminalState[]>();
  private readonly legacySnapshots = new Map<string, TerminalState[]>();

  constructor(private readonly onSessionChanged?: (sessionId: string) => void, private readonly archive?: TerminalOutputArchive) {}

  readonly hooks: AgentTerminalHooks = {
    onTerminalCreated: ({ sessionId, scope, snapshot }) => this.hostSnapshot(sessionId, scope, snapshot),
    onTerminalOutput: ({ sessionId, scope, snapshot, chunk }) => this.hostOutput(sessionId, scope, snapshot, chunk),
    onTerminalExit: ({ sessionId, scope, snapshot }) => this.hostSnapshot(sessionId, scope, snapshot),
    onTerminalReleased: ({ sessionId, scope, terminalId }) => {
      const record = this.bySession.get(sessionId)?.get(terminalEntityId(scope, terminalId));
      if (!record) return;
      record.state = { ...record.state, canKill: false };
      this.invalidate(sessionId, record);
      this.onSessionChanged?.(sessionId);
    },
  };

  private hostOutput(sessionId: string, scope: string, snapshot: TerminalState, chunk: string): void {
    const terminalId = terminalEntityId(scope, snapshot.terminalId);
    const record = this.session(sessionId).get(terminalId);
    if (!record) throw new Error('Host terminal output arrived before creation');
    const bytes = Buffer.from(chunk);
    this.archive?.append(sessionId, terminalId, bytes);
    record.output.append(bytes);
    const { output: _output, ...state } = snapshot;
    record.state = { ...state, terminalId, truncated: state.truncated || record.output.truncated };
    this.invalidate(sessionId, record);
    this.onSessionChanged?.(sessionId);
  }

  private hostSnapshot(sessionId: string, scope: string, snapshot: TerminalState): void {
    const { output, ...state } = snapshot;
    const terminalId = terminalEntityId(scope, state.terminalId);
    let record = this.session(sessionId).get(terminalId);
    if (!record) {
      record = { state: { ...state, terminalId }, output: new TerminalOutput() };
      const bytes = Buffer.from(output);
      this.archive?.seed(sessionId, terminalId, bytes);
      record.output.reset(bytes);
      this.session(sessionId).set(terminalId, record);
    }
    record.state = { ...state, terminalId, truncated: state.truncated || record.output.truncated };
    if (state.exitStatus) record.output.finish();
    this.invalidate(sessionId, record);
    this.onSessionChanged?.(sessionId);
  }

  accept(sessionId: string, scope: string, event: Extract<NormalizedEvent, { kind: 'terminal_update' | 'terminal_chunk' }>): void {
    const terminalId = terminalEntityId(scope, event.terminal.terminalId);
    const session = this.session(sessionId);
    const existing = session.get(terminalId);
    const record = existing ?? {
      state: { terminalId, owner: 'agent' as const, canKill: false, command: '', args: [], cwd: '', truncated: false, exitStatus: null },
      output: new TerminalOutput(),
    };
    if (record.state.owner !== 'agent') throw new Error('Agent update targets a host-owned terminal');
    if (event.kind === 'terminal_chunk') {
      const bytes = Buffer.from(event.terminal.data, 'base64');
      this.archive?.append(sessionId, terminalId, bytes);
      record.output.append(bytes);
    } else {
      const update = event.terminal;
      for (const key of ['command', 'cwd'] as const) {
        if (update[key] !== undefined) record.state = { ...record.state, [key]: update[key] ?? '' };
      }
      // Completion summaries may be provider-truncated; the streamed bytes remain authoritative.
      if (update.output !== undefined && !(record.output.streamed && update.exitStatus)) {
        const bytes = Buffer.from(update.output?.data ?? '', 'base64');
        if (existing) {
          this.archive?.reset(sessionId, terminalId);
          this.archive?.append(sessionId, terminalId, bytes);
        } else this.archive?.seed(sessionId, terminalId, bytes);
        record.output.reset(bytes);
      }
      if (update.exitStatus !== undefined) record.state = { ...record.state, exitStatus: update.exitStatus === null ? null : {
        exitCode: update.exitStatus.exitCode ?? null, signal: update.exitStatus.signal ?? null,
      } };
      record.state = { ...record.state, _meta: patchEntityMeta(record.state._meta, update._meta) };
    }
    if (record.state.exitStatus) record.output.finish();
    record.state = { ...record.state, truncated: record.output.truncated };
    session.set(terminalId, record);
    this.invalidate(sessionId, record);
    if (event.kind !== 'terminal_chunk') this.onSessionChanged?.(sessionId);
  }

  private invalidate(sessionId: string, record: TerminalRecord): void {
    record.snapshot = undefined;
    record.wireSnapshot = undefined;
    record.legacySnapshot = undefined;
    this.snapshots.delete(sessionId);
    this.wireSnapshots.delete(sessionId);
    this.legacySnapshots.delete(sessionId);
  }

  private session(sessionId: string): Map<string, TerminalRecord> {
    let session = this.bySession.get(sessionId);
    if (!session) this.bySession.set(sessionId, (session = new Map()));
    return session;
  }

  /** 只读:没变时同一组原样再给下一位,❌ 原地改。 */
  snapshotSession(sessionId: string, wire: boolean | 'legacy' = false): TerminalState[] {
    const cache = wire === 'legacy' ? this.legacySnapshots : wire ? this.wireSnapshots : this.snapshots;
    const cached = cache.get(sessionId);
    if (cached) return cached;
    const session = this.bySession.get(sessionId);
    if (!session) return [];
    const snapshots = [...session.values()].map((record) => {
      if (wire === 'legacy') return record.legacySnapshot ??= { ...record.state,
        output: record.output.text(LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT),
        truncated: record.state.truncated || record.output.retainedBytes > LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT,
      };
      if (wire) return record.wireSnapshot ??= {
        ...record.state, output: '', outputChunks: record.output.snapshot(),
        ...(this.archive ? { outputBytes: this.archive.size(sessionId, record.state.terminalId) } : {}),
      };
      return record.snapshot ??= { ...record.state, output: record.output.text(),
        ...(this.archive ? { outputBytes: this.archive.size(sessionId, record.state.terminalId) } : {}),
      };
    });
    cache.set(sessionId, snapshots);
    return snapshots;
  }

  disposeSession(sessionId: string): void {
    this.bySession.delete(sessionId);
    this.snapshots.delete(sessionId);
    this.wireSnapshots.delete(sessionId);
    this.legacySnapshots.delete(sessionId);
  }

  readOutput(sessionId: string, terminalId: string, offset: number, limit: number) {
    if (!this.archive) throw new Error('Terminal output archive unavailable');
    return this.archive.read(sessionId, terminalId, offset, limit);
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
