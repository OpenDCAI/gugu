import { normalizeSignal, PosixPtyTerminator } from '@gugu/session-core/pty';
import * as nodePty from 'node-pty';
import { CONPTY_SPAWN_OPTIONS, releaseConoutWorkerOnExit } from '@gugu/session-core/pty/node';
import type { IPty } from 'node-pty';
import { log } from '@main/lib/logger';
import { suppressExpectedNodePtyErrors } from './node-pty-errors';
import type { Pty, PtyDimensions, PtyExitInfo } from './pty';

export interface LocalSpawnOptions extends PtyDimensions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const MIN_COLS = 2;
const MIN_ROWS = 1;

type OwnedLocalPty = Pick<LocalPtySession, 'kill' | 'onExit'>;

export class LocalPtyOwner {
  private readonly sessions = new Set<OwnedLocalPty>();
  private disposing = false;

  assertAccepting(): void {
    if (this.disposing) throw new Error('Local PTY owner is disposing');
  }

  own<T extends OwnedLocalPty>(session: T): T {
    this.assertAccepting();
    this.sessions.add(session);
    session.onExit(() => this.sessions.delete(session));
    return session;
  }

  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const failures: unknown[] = [];
    for (const session of this.sessions) {
      try {
        session.kill();
      } catch (error) {
        failures.push(error);
      }
    }
    this.sessions.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Local PTY cleanup failed');
  }
}

const localPtyOwner = new LocalPtyOwner();

export function spawnLocalPty(options: LocalSpawnOptions): LocalPtySession {
  const { id, command, args, cwd, env, cols, rows } = options;

  log.info('LocalPtySession:spawn', {
    id,
    command,
    args,
    cwd,
    cols,
    rows,
  });

  try {
    localPtyOwner.assertAccepting();
    const proc = nodePty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      ...CONPTY_SPAWN_OPTIONS,
    });
    suppressExpectedNodePtyErrors(proc);
    releaseConoutWorkerOnExit(proc);
    return localPtyOwner.own(new LocalPtySession(id, proc));
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Failed to spawn PTY: ${message}`);
  }
}

export function disposeLocalPtySessions(): void {
  localPtyOwner.dispose();
}

export class LocalPtySession implements Pty {
  readonly id: string;
  private killed = false;

  constructor(
    id: string,
    private readonly proc: IPty,
    private readonly posixTerminator: Pick<
      PosixPtyTerminator,
      'kill' | 'markExited'
    > = new PosixPtyTerminator(log)
  ) {
    this.id = id;
    this.proc.onExit(() => {
      this.posixTerminator.markExited();
    });
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    const c = Number.isFinite(cols) ? Math.max(MIN_COLS, Math.floor(cols)) : MIN_COLS;
    const r = Number.isFinite(rows) ? Math.max(MIN_ROWS, Math.floor(rows)) : MIN_ROWS;
    try {
      this.proc.resize(c, r);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/EBADF|ENOTTY|ioctl\(2\) failed|not open|Napi::Error/.test(msg)) {
        return;
      }
      log.error('LocalPtySession:resize failed', { cols: c, rows: r, error: msg });
    }
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;

    const pid = this.proc.pid;
    if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
      this.killPty();
      return;
    }

    this.posixTerminator.kill(pid, () => this.killPty());
  }

  private killPty(): void {
    try {
      this.proc.kill();
    } catch {}
  }

  onData(handler: (data: string) => void): void {
    this.proc.onData(handler);
  }

  onExit(handler: (info: PtyExitInfo) => void): void {
    this.proc.onExit(({ exitCode, signal }) => {
      handler({ exitCode, signal: normalizeSignal(signal) });
    });
  }

  getPid(): number {
    return this.proc.pid;
  }
}
