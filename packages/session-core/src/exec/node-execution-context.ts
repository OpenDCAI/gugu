import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecContextOptions, IExecutionContext } from './execution-context';
import type { ExecResult } from './types';
import { spawnOwnedChild } from './owned-child';
import { execInProcessGroup } from './process-group';
import { planDirectSpawn } from './windows-launcher';

const execFileAsync = promisify(execFile);

export class NodeExecutionContext implements IExecutionContext {
  readonly supportsLocalSpawn = true;
  readonly root: string;

  private readonly lifetime = new AbortController();

  constructor(options: { root?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.root = options.root ?? '';
    this.env = options.env;
  }

  private readonly env: NodeJS.ProcessEnv | undefined;

  exec(command: string, args: string[] = [], opts: ExecContextOptions = {}): Promise<ExecResult> {
    // 调用方给的那份是**完整**的,照单全用(#5702)。
    const env = opts.env ?? this.env;
    // `.cmd` / `.bat` 壳在 Windows 上不能裸执行 —— 见 windows-launcher.ts(#5719)。
    const launch = planDirectSpawn(command, args, { env });
    // execFile 的超时/中止只杀得到壳:包了壳的执行交给整树停的那条路。
    if (opts.processGroup || launch.wrapsShell) {
      return execInProcessGroup(command, args, {
        cwd: this.root || undefined,
        env,
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer,
        signal: this.signal(opts.signal),
      });
    }
    return execFileAsync(launch.command, launch.args, {
      cwd: this.root || undefined,
      env,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
      signal: this.signal(opts.signal),
      ...launch.spawnOverrides,
    }) as Promise<ExecResult>;
  }

  execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this.signal(opts.signal);
      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      let settled = false;
      const owned = spawnOwnedChild(command, args, {
        cwd: this.root || undefined,
        env: this.env,
        onError: (error) => onChildError(error),
      });
      const child = owned.child;

      const onAbort = () => {
        if (settled) return;
        settled = true;
        const reason = signal.reason ?? new DOMException('Aborted', 'AbortError');
        owned.stop().then(() => reject(reason), reject);
      };
      signal.addEventListener('abort', onAbort, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (!settled && !onChunk(chunk)) owned.kill();
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (!settled) onChunk(chunk);
      });

      // spawn 失败,或停不下来的树。
      const onChildError = (error: Error): void => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }

  dispose(): void {
    this.lifetime.abort();
  }

  private signal(callerSignal?: AbortSignal): AbortSignal {
    return callerSignal
      ? AbortSignal.any([this.lifetime.signal, callerSignal])
      : this.lifetime.signal;
  }
}
