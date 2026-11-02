import { LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT, TERMINAL_OUTPUT_BYTE_LIMIT, terminalEntityId, patchEntityMeta, type NormalizedEvent, type TerminalState } from '@gugu/session-core/acp';
import type { AgentTerminalHooks } from '../agent-ports/terminal-manager';
import { TerminalOutput } from './terminal-output';

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
  private readonly outputBudgets = new Map<string, { bytes: number; recent: Map<TerminalRecord, number> }>();

  constructor(private readonly onSessionChanged?: (sessionId: string) => void) {}

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
    record.output.append(bytes);
    this.boundOutput(sessionId, record);
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
      record.output.reset(bytes);
      this.session(sessionId).set(terminalId, record);
    }
    record.state = { ...state, terminalId, truncated: state.truncated || record.output.truncated };
    if (state.exitStatus) record.output.finish();
    this.boundOutput(sessionId, record);
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
      record.output.append(bytes);
    } else {
      const update = event.terminal;
      for (const key of ['command', 'cwd'] as const) {
        if (update[key] !== undefined) record.state = { ...record.state, [key]: update[key] ?? '' };
      }
      // Providers can deliver their empty started snapshot after the first byte deltas.
      // Once streaming begins, snapshots (including clipped completion summaries) cannot reset it.
      // An explicit null remains the protocol's clear operation.
      if (update.output !== undefined && (!record.output.streamed || update.output === null)) {
        const bytes = Buffer.from(update.output?.data ?? '', 'base64');
        record.output.reset(bytes);
      }
      if (update.exitStatus !== undefined) record.state = { ...record.state, exitStatus: update.exitStatus === null ? null : {
        exitCode: update.exitStatus.exitCode ?? null, signal: update.exitStatus.signal ?? null,
      } };
      record.state = { ...record.state, _meta: patchEntityMeta(record.state._meta, update._meta) };
    }
    if (record.state.exitStatus) record.output.finish();
    this.boundOutput(sessionId, record);
    record.state = { ...record.state, truncated: record.output.truncated };
    session.set(terminalId, record);
    this.invalidate(sessionId, record);
    if (event.kind !== 'terminal_chunk') this.onSessionChanged?.(sessionId);
  }

  /** Many completed commands must not turn one subscription snapshot into an unbounded IPC frame. */
  private boundOutput(sessionId: string, record: TerminalRecord): void {
    let budget = this.outputBudgets.get(sessionId);
    if (!budget) this.outputBudgets.set(sessionId, (budget = { bytes: 0, recent: new Map() }));
    budget.bytes -= budget.recent.get(record) ?? 0;
    budget.recent.delete(record);
    if (record.output.retainedBytes) {
      budget.recent.set(record, record.output.retainedBytes);
      budget.bytes += record.output.retainedBytes;
    }
    const limit = TERMINAL_OUTPUT_BYTE_LIMIT;
    while (budget.bytes > limit) {
      const [oldest, bytes] = budget.recent.entries().next().value!;
      oldest.output.trimTo(Math.max(0, bytes - (budget.bytes - limit)));
      const retained = oldest.output.retainedBytes;
      budget.bytes -= bytes - retained;
      if (retained) budget.recent.set(oldest, retained);
      else budget.recent.delete(oldest);
      oldest.state = { ...oldest.state, truncated: true };
      this.invalidate(sessionId, oldest);
    }
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
        outputBytes: record.output.bytes,
        output: record.output.text(LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT),
        truncated: record.state.truncated || record.output.retainedBytes > LEGACY_TERMINAL_OUTPUT_BYTE_LIMIT,
      };
      if (wire) return record.wireSnapshot ??= {
        ...record.state, output: '', outputChunks: record.output.snapshot(),
        outputBytes: record.output.bytes,
      };
      return record.snapshot ??= { ...record.state, output: record.output.text(),
        outputBytes: record.output.bytes,
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
    this.outputBudgets.delete(sessionId);
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
