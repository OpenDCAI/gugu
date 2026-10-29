import type { TerminalState } from '@gugu/session-core/acp';
import type { AcpProcessHost } from '@gugu/session-core/acp/node';
import { log } from '@gugu/session-shared/logger';
import { ManagedAgentTerminal } from './managed-terminal';

type TerminalHost = Pick<AcpProcessHost, 'spawnTerminal'>;

export interface AgentTerminalHooks {
  onTerminalCreated(e: {
    scope: string;
    snapshot: TerminalState;
    sessionId: string;
    terminalId: string;
    command: string;
    args: string[];
    cwd: string;
  }): void;
  onTerminalOutput(e: {
    scope: string;
    snapshot: TerminalState;
    sessionId: string;
    terminalId: string;
    chunk: string;
    truncated: boolean;
  }): void;
  onTerminalExit(e: {
    scope: string;
    snapshot: TerminalState;
    sessionId: string;
    terminalId: string;
    exitStatus: { exitCode: number | null; signal: string | null };
  }): void;
  onTerminalReleased(e: { sessionId: string; scope: string; terminalId: string }): void;
}

/**
 * Host-scoped registry of all ACP agent-requested terminals.
 */
export class AgentTerminalManager {
  private readonly byId = new Map<
    string,
    { sessionId: string; scope: string; terminal: ManagedAgentTerminal }
  >();
  private readonly bySession = new Map<string, Set<string>>();

  constructor(
    private readonly host: TerminalHost,
    private readonly hooks: AgentTerminalHooks
  ) {}

  /** True when the host supports spawning agent terminals. */
  supportsTerminals(): boolean {
    return typeof this.host.spawnTerminal === 'function';
  }

  /**
   * Spawn a terminal command and register it under the given conversation.
   * Emits `onTerminalCreated` synchronously after registration.
   * Throws if the host does not support terminal spawning.
   */
  async create(
    sessionId: string,
    spec: {
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      outputByteLimit?: number | null;
      scope?: string;
    }
  ): Promise<string> {
    if (!this.host.spawnTerminal) {
      throw new Error(
        'AgentTerminalManager: host does not support terminal spawning (spawnTerminal is undefined)'
      );
    }

    const terminalId = crypto.randomUUID();
    const scope = spec.scope ?? sessionId;
    const proc = await this.host.spawnTerminal(spec);

    const terminal = new ManagedAgentTerminal(
      terminalId,
      spec.command,
      spec.args,
      spec.cwd,
      proc,
      (chunk, truncated) => {
        this.hooks.onTerminalOutput({ sessionId, scope, terminalId, chunk, truncated, snapshot: terminal.snapshot() });
      },
      (exitStatus) => {
        this.hooks.onTerminalExit({ sessionId, scope, terminalId, exitStatus, snapshot: terminal.snapshot() });
      },
      spec.outputByteLimit
    );

    this.byId.set(terminalId, { sessionId, scope, terminal });
    let ids = this.bySession.get(sessionId);
    if (!ids) {
      ids = new Set();
      this.bySession.set(sessionId, ids);
    }
    ids.add(terminalId);

    this.hooks.onTerminalCreated({
      scope,
      snapshot: terminal.snapshot(),
      sessionId,
      terminalId,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
    });

    return terminalId;
  }

  /** Retrieve a live terminal by id. Returns undefined if not found. */
  get(terminalId: string): ManagedAgentTerminal | undefined {
    return this.byId.get(terminalId)?.terminal;
  }

  getOwned(terminalId: string, scope: string): ManagedAgentTerminal | undefined {
    const entry = this.byId.get(terminalId);
    return entry?.scope === scope ? entry.terminal : undefined;
  }

  /** Snapshots of all live terminals for a conversation. */
  listBySession(sessionId: string): TerminalState[] {
    const ids = this.bySession.get(sessionId);
    if (!ids) return [];
    const out: TerminalState[] = [];
    for (const id of ids) {
      const entry = this.byId.get(id);
      if (entry) out.push(entry.terminal.snapshot());
    }
    return out;
  }

  /** Snapshots of all live terminals across all conversations on this host. */
  listAll(): TerminalState[] {
    const out: TerminalState[] = [];
    for (const { terminal } of this.byId.values()) {
      out.push(terminal.snapshot());
    }
    return out;
  }

  /**
   * Dispose a single terminal and remove it from the registry.
   * Emits `onTerminalReleased`. No-op if the id is unknown.
   */
  release(terminalId: string): void {
    const entry = this.byId.get(terminalId);
    if (!entry) return;
    const { sessionId, scope, terminal } = entry;
    terminal.dispose();
    this.byId.delete(terminalId);
    this.bySession.get(sessionId)?.delete(terminalId);
    if (this.bySession.get(sessionId)?.size === 0) {
      this.bySession.delete(sessionId);
    }
    this.hooks.onTerminalReleased({ sessionId, scope, terminalId });
  }

  /**
   * Dispose all terminals belonging to a conversation (called on session close).
   * Emits `onTerminalReleased` for each terminal.
   */
  disposeSession(sessionId: string): void {
    const ids = this.bySession.get(sessionId);
    if (!ids) return;
    this.releaseBatch([...ids]);
  }

  /**
   * Dispose every terminal on this host (called on host teardown).
   * Emits `onTerminalReleased` for each terminal.
   */
  killAll(): void {
    this.releaseBatch([...this.byId.keys()]);
  }

  private releaseBatch(ids: string[]): void {
    for (const terminalId of ids) {
      try {
        this.release(terminalId);
      } catch (error) {
        // 保留失败进程的 registry 所有权；报告失败但继续收其余终端/会话连接。
        log.error('ACP terminal process cleanup failed', {
          terminalId,
          sessionId: this.byId.get(terminalId)?.sessionId,
          error,
        });
      }
    }
  }
}
