import type { ChildProcessWithoutNullStreams, StdioOptions } from 'node:child_process';
import { deserializeMessage, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { spawnOwnedChild, type OwnedChild } from '@gugu/session-core/exec';
import { loginShellEnv } from '@main/utils/userEnv';
import { buildUserShellBaseEnv } from '@main/utils/childProcessEnv';
import { getWindowsEnvValue } from '@main/utils/windows-env';

const STOP_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 4096;

/**
 * The person's PATH, as every other spawn gets it (pty-env.ts): the base layer leaves PATH out on purpose and the host
 * computes it — the login shell's, merged into process.env at startup with gugu's own bin dirs first. Without it a
 * `command` found on PATH (`npx`, `uvx`, `python3`, as the guide says) and whatever a program starts are not found
 * (10-06 mac1: `spawn npx ENOENT` with npx installed).
 */
const hostPath = () => (process.platform === 'win32' ? getWindowsEnvValue(process.env, 'PATH') : process.env.PATH) ?? '';

export interface OwnedStdioSpawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** A fourth slot (`'ipc'`) when the program talks to gugu besides its MCP stdin / stdout. */
  stdio?: StdioOptions;
  serialization?: 'advanced';
}

/** The program's own last line on stderr — "missing API key" says more than "exited with code 4". */
export function lastStderrLine(text: string): string {
  // Node appends a stack (`at …`), a `^` marker and its own version to a crash; none of that is the program speaking.
  const noise = [/^at /, /^\^+$/, /^Node\.js v\d/];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !noise.some((re) => re.test(line)));
  return lines.at(-1) ?? '';
}

/**
 * An MCP stdio server run by gugu itself: started in the person's shell environment, its stderr tail kept for the
 * reason it failed, and the whole process tree taken down on close — App programs and the library's connection check
 * both start their programs through this one.
 */
export class OwnedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  stderrTail = '';
  owned: OwnedChild<ChildProcessWithoutNullStreams> | null = null;
  private pending: Buffer | undefined;

  /** `spawn` is read at start; `onSpawned` / `onClosed` let an owner attach to the child (App programs' surface). */
  constructor(
    private readonly spawn: () => OwnedStdioSpawn,
    private readonly hooks: { onSpawned?: (child: ChildProcessWithoutNullStreams) => void; onClosed?: () => void } = {},
  ) {}

  private receive(line: string): void {
    let message: JSONRPCMessage;
    try {
      message = deserializeMessage(line);
    } catch (error) {
      this.onerror?.(error as Error);
      return;
    }
    this.onmessage?.(message);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const spec = this.spawn();
      this.owned = spawnOwnedChild(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...buildUserShellBaseEnv({ loginShellEnv: loginShellEnv() }), PATH: hostPath(), ...spec.env },
        stdio: spec.stdio ?? 'pipe',
        ...(spec.serialization ? { serialization: spec.serialization } : {}),
        detached: true,
        onError: (error) => {
          reject(error);
          this.onerror?.(error);
        },
      }) as OwnedChild<ChildProcessWithoutNullStreams>;
      const { child } = this.owned;
      this.hooks.onSpawned?.(child);
      child.once('spawn', () => resolve());
      child.once('close', () => {
        this.hooks.onClosed?.();
        this.onclose?.();
      });
      child.stdin.on('error', (error) => this.onerror?.(error));
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        this.pending = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
        for (let end = this.pending.indexOf(0x0a); end !== -1; end = this.pending.indexOf(0x0a)) {
          const line = this.pending.toString('utf8', 0, end).replace(/\r$/, '');
          this.pending = this.pending.subarray(end + 1);
          this.receive(line);
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.owned?.child.stdin;
    if (!stdin?.writable) return Promise.reject(new Error('MCP program is not running'));
    return new Promise<void>((resolve) => void (stdin.write(serializeMessage(message)) ? resolve() : stdin.once('drain', resolve)));
  }

  /** stdin closed first so a well-behaved program exits by itself; whatever is left of the tree is then killed. */
  async close(): Promise<void> {
    const owned = this.owned;
    if (owned?.child.pid === undefined) return;
    const { child } = owned;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.stdin.end();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, STOP_GRACE_MS))]);
    }
    await owned.stop({ graceMs: STOP_GRACE_MS, killMs: STOP_GRACE_MS });
  }
}
