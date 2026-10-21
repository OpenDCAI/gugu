import type { IDisposable } from '@gugu/session-shared';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';
import { createLifecycleScriptTerminalId } from '@shared/core/terminals/terminals';
import type { Pty, PtyExitInfo } from '../pty/pty';
import { ptySessionRegistry } from '../pty/pty-session-registry';
import type { TerminalProvider } from '../terminals/terminal-provider';

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const OUTPUT_TAIL_CAP = 16 * 1024;

type LifecycleScript = {
  type: 'setup' | 'run' | 'teardown';
  script: string;
  shellSetup?: string;
};

type LifecycleRespawnRequest = {
  script: LifecycleScript;
  initialSize: { cols: number; rows: number };
};

export type LifecycleScriptExecutionResult =
  | { kind: 'started' }
  | { kind: 'already-running' }
  | {
      kind: 'exited';
      exitCode?: number;
      signal?: string | number;
      outputTail: string;
    };

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\][^\x1b]*\x1b\\/g, '')
    .replace(/\r/g, '');
}

function appendOutputTail(current: string, chunk: string): string {
  const next = current + stripTerminalControls(chunk);
  return next.length > OUTPUT_TAIL_CAP ? next.slice(-OUTPUT_TAIL_CAP) : next;
}

function terminalInputForScript(script: string, exit: boolean, windowsCmdExit: boolean): string {
  const normalizedScript = script.replace(/\r?\n/g, '\r');
  if (!exit) return `${normalizedScript}\r`;
  const scriptBeforeExit = normalizedScript.replace(/\r+$/, '');
  return windowsCmdExit ? `${scriptBeforeExit}\rexit\r` : `${scriptBeforeExit}; exit\r`;
}

export class LifecycleScriptService implements IDisposable {
  private readonly projectId: string;
  private readonly workspaceId: string;
  private readonly terminals: TerminalProvider;
  private readonly ptySessionsWithRespawnHandler = new Set<string>();
  private readonly ptySessionsWaitingForExit = new Set<string>();
  private readonly latestRespawnRequest = new Map<string, LifecycleRespawnRequest>();
  private disposed = false;

  constructor({
    projectId,
    workspaceId,
    terminals,
  }: {
    projectId: string;
    workspaceId: string;
    terminals: TerminalProvider;
  }) {
    this.projectId = projectId;
    this.workspaceId = workspaceId;
    this.terminals = terminals;
  }

  private respawnAfterExit(ptySessionId: string): void {
    const respawnRequest = this.latestRespawnRequest.get(ptySessionId);
    this.latestRespawnRequest.delete(ptySessionId);
    this.ptySessionsWithRespawnHandler.delete(ptySessionId);
    if (this.disposed || !respawnRequest) return;
    void this.prepareLifecycleScript(respawnRequest.script, {
      initialSize: respawnRequest.initialSize,
    });
  }

  private ensureRespawnAfterExit({
    ptySessionId,
    pty,
    script,
    initialSize,
  }: {
    ptySessionId: string;
    pty: Pty;
    script: LifecycleScript;
    initialSize: { cols: number; rows: number };
  }): void {
    // Restores the user-facing prompt after manual script completion/stop. Later reruns
    // already work because the PTY registry drops exited sessions.
    this.latestRespawnRequest.set(ptySessionId, { script, initialSize });
    if (this.ptySessionsWithRespawnHandler.has(ptySessionId)) return;

    this.ptySessionsWithRespawnHandler.add(ptySessionId);
    pty.onExit(() => this.respawnAfterExit(ptySessionId));
  }

  private resolveIds(script: Pick<LifecycleScript, 'type'>): {
    terminalId: string;
    ptySessionId: string;
  } {
    const terminalId = createLifecycleScriptTerminalId(script.type);
    const ptySessionId = makePtySessionId(this.projectId, this.workspaceId, terminalId);
    return { terminalId, ptySessionId };
  }

  private async shouldUseWindowsCommandExit(terminalId: string): Promise<boolean> {
    if (this.terminals.kind !== 'local' || process.platform !== 'win32') return false;
    const shellFamily = await this.terminals.getLifecycleScriptShellFamily?.(terminalId);
    return shellFamily === 'windows-cmd' || shellFamily === 'powershell';
  }

  async prepareLifecycleScript(
    script: LifecycleScript,
    options: { initialSize?: { cols: number; rows: number } } = {}
  ): Promise<Pty | null> {
    const { initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS } } = options;
    const { terminalId, ptySessionId } = this.resolveIds(script);
    const existingPty = ptySessionRegistry.get(ptySessionId);
    if (existingPty) return existingPty;

    await this.terminals.spawnLifecycleScript({
      terminal: {
        id: terminalId,
        projectId: this.projectId,
        shellId: 'system',
        name: script.type,
      },
      shellSetup: script.shellSetup,
      initialSize,
      respawnOnExit: false,
      preserveBufferOnExit: true,
      watchDevServer: script.type === 'run',
    });

    return ptySessionRegistry.get(ptySessionId) ?? null;
  }

  async runLifecycleScript(
    script: LifecycleScript,
    options: {
      waitForExit?: boolean;
      exit?: boolean;
      respawnAfterExit?: boolean;
      initialSize?: { cols: number; rows: number };
    } = {}
  ): Promise<LifecycleScriptExecutionResult> {
    const {
      waitForExit = false,
      exit = false,
      respawnAfterExit = false,
      initialSize = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
    } = options;

    const { terminalId, ptySessionId } = this.resolveIds(script);

    const pty = await this.prepareLifecycleScript(script, { initialSize });
    if (!pty) {
      throw new Error(
        `Lifecycle script session unavailable for ${script.type} in workspace ${this.workspaceId}`
      );
    }

    if (waitForExit) {
      if (this.ptySessionsWaitingForExit.has(ptySessionId)) {
        return { kind: 'already-running' };
      }
      this.ptySessionsWaitingForExit.add(ptySessionId);
    }

    if (exit && (respawnAfterExit || !waitForExit)) {
      this.ensureRespawnAfterExit({ ptySessionId, pty, script, initialSize });
    }

    try {
      let outputTail = '';
      const exitPromise = waitForExit
        ? new Promise<PtyExitInfo>((resolve) => {
            pty.onData((data) => {
              outputTail = appendOutputTail(outputTail, data);
            });
            pty.onExit((info) => resolve(info));
          })
        : null;

      pty.write(
        terminalInputForScript(
          script.script,
          exit,
          await this.shouldUseWindowsCommandExit(terminalId)
        )
      );

      if (!exitPromise) {
        return { kind: 'started' };
      }

      const exitInfo = await exitPromise;
      return {
        kind: 'exited',
        exitCode: exitInfo.exitCode,
        signal: exitInfo.signal,
        outputTail,
      };
    } finally {
      if (waitForExit) {
        this.ptySessionsWaitingForExit.delete(ptySessionId);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.ptySessionsWithRespawnHandler.clear();
    this.ptySessionsWaitingForExit.clear();
    this.latestRespawnRequest.clear();
    await this.terminals.destroyAll();
  }
}
