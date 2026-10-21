import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getGitExecutable,
  isMissingGitExecutableError,
  missingGitExecutableError,
} from '@main/core/utils/exec';
import { execInProcessGroup, planDirectSpawn, spawnOwnedChild } from '@gugu/session-core/exec';
import { NON_INTERACTIVE_GIT_ENV } from './non-interactive-git-env';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import type { ExecContextOptions, ExecResult, IExecutionContext } from '@gugu/session-core/exec';

const execFileAsync = promisify(execFile);

function buildNonInteractiveGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...NON_INTERACTIVE_GIT_ENV,
  };
}

export class LocalExecutionContext implements IExecutionContext {
  readonly root: string;
  readonly supportsLocalSpawn = true;

  private readonly _lifetime = new AbortController();

  constructor(opts: { root?: string } = {}) {
    this.root = opts.root ?? '';
  }

  private _signal(callerSignal?: AbortSignal): AbortSignal {
    const signals: AbortSignal[] = [this._lifetime.signal];
    if (callerSignal) signals.push(callerSignal);
    return AbortSignal.any(signals);
  }

  private resolveCommand(command: string): string {
    return command === 'git' ? getGitExecutable() : command;
  }

  exec(command: string, args: string[] = [], opts: ExecContextOptions = {}): Promise<ExecResult> {
    const { timeout, maxBuffer } = opts;
    // 调用方给的那份是宿主算好的**完整**环境,照单全用(#5702);没给才回到通用外部工具环境。
    const env =
      opts.env ?? (command === 'git' ? buildNonInteractiveGitEnv() : buildExternalToolEnv());
    // `.cmd` / `.bat` 壳在 Windows 上不能裸执行 —— 见 windows-launcher.ts(#5719)。
    const resolved = this.resolveCommand(command);
    const launch = planDirectSpawn(resolved, args, { env });
    // execFile 的超时/中止只杀得到壳:包了壳的执行交给整树停的那条路。
    if (opts.processGroup || launch.wrapsShell) {
      return execInProcessGroup(resolved, args, {
        cwd: this.root || undefined,
        env,
        timeout,
        maxBuffer,
        signal: this._signal(opts.signal),
      });
    }
    return execFileAsync(launch.command, launch.args, {
      cwd: this.root || undefined,
      env,
      timeout,
      maxBuffer,
      signal: this._signal(opts.signal),
      ...launch.spawnOverrides,
    }).catch((error) => {
      if (command === 'git' && isMissingGitExecutableError(error)) {
        throw missingGitExecutableError();
      }
      throw error;
    }) as Promise<ExecResult>;
  }

  execStreaming(
    command: string,
    args: string[],
    onChunk: (chunk: string) => boolean,
    opts: { signal?: AbortSignal } = {}
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const signal = this._signal(opts.signal);

      if (signal.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        return;
      }

      const streamEnv = command === 'git' ? buildNonInteractiveGitEnv() : buildExternalToolEnv();
      let settled = false;
      const owned = spawnOwnedChild(this.resolveCommand(command), args, {
        cwd: this.root || undefined,
        env: streamEnv,
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
        if (settled) return;
        if (!onChunk(chunk)) {
          owned.kill();
        }
      });

      // spawn 失败,或停不下来的树。
      const onChildError = (err: Error): void => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          reject(
            command === 'git' && isMissingGitExecutableError(err)
              ? missingGitExecutableError()
              : err
          );
        }
      };

      child.on('close', () => {
        signal.removeEventListener('abort', onAbort);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
    });
  }

  dispose(): void {
    this._lifetime.abort();
  }
}
