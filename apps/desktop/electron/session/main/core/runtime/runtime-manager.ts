import nodePath from 'node:path';
import {
  createBoundExec,
  type BoundExec,
  type ExecBufferResult,
  type ExecOptions,
  type ExecResult,
} from '@gugu/session-core/exec';
import { contains, FilesRuntime } from '@gugu/session-core/files';
import { GitRuntime } from '@gugu/session-core/git';
import { ResourceMap } from '@gugu/session-core/lib';
import { spawnFsWatchWorker } from '@gugu/session-core/services/fs-watch/worker';
import type { Lease } from '@gugu/session-shared';
import { appScope } from '@main/app/app-scope';
import {
  getDependencyManager,
} from '@main/core/dependencies/dependency-managers';
import { reviewGitEnv } from './review-git-env';
import { getGitExecutable } from '@main/core/utils/exec';
import { detectSshAuthSock } from '@main/utils/shellEnv';
import { loginShellEnv } from '@main/utils/userEnv';
import { log } from '@main/lib/logger';
import { desktopWorkerPath } from '@main/worker-manifest';
import { ConstantHealthSource } from './health';
import {
  type MachineRuntime,
  type RuntimeManager,
  type RuntimePath,
} from './types';

const nativeRuntimePath: RuntimePath = {
  join: (...parts) => nodePath.join(...parts),
  dirname: (p) => nodePath.dirname(p),
  basename: (p) => nodePath.basename(p),
  isAbsolute: (p) => nodePath.isAbsolute(p),
  relative: (from, to) => nodePath.relative(from, to),
  contains,
};

class DynamicGitExec implements BoundExec {
  readonly file = 'git';
  /** 每次取:登录 shell 快照会在装完 agent 后重采一次。 */
  get env(): NodeJS.ProcessEnv {
    return reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv(), sshAuthSock: detectSshAuthSock });
  }

  constructor(
    readonly cwd: string,
    private readonly connectionId?: string
  ) {}

  exec(args: string[], options?: ExecOptions): Promise<ExecResult> {
    return this.current().exec(args, options);
  }

  execStreaming(
    args: string[],
    onStdout: (chunk: string) => boolean | void,
    options?: ExecOptions
  ): Promise<void> {
    return this.current().execStreaming(args, onStdout, options);
  }

  execBuffer(args: string[], options?: ExecOptions): Promise<ExecBufferResult> {
    return this.current().execBuffer(args, options);
  }

  withCwd(cwd: string): BoundExec {
    return new DynamicGitExec(cwd, this.connectionId);
  }

  private current(): BoundExec {
    return createBoundExec({
      file: getGitExecutable(this.connectionId),
      cwd: this.cwd,
      env: this.env,
    });
  }
}

class LocalMachineRuntime implements MachineRuntime {
  private readonly scope = appScope.child('local-machine-runtime');
  private readonly watcher = spawnFsWatchWorker({
    entry: desktopWorkerPath('fs-watch'),
    scope: this.scope,
    env: process.env,
    onError: (context, error) =>
      log.warn('File watching background error', { context, error: String(error) }),
  });
  readonly files = Object.assign(
    new FilesRuntime({
      watcher: this.watcher,
      onError: (context, error) =>
        log.warn('Local file runtime background error', { context, error: String(error) }),
    }),
    { path: nativeRuntimePath }
  );
  readonly git = new GitRuntime({
    exec: new DynamicGitExec(process.cwd()),
    watcher: this.watcher,
    onError: (context, error) =>
      log.warn('Local GitRuntime background error', { context, error: String(error) }),
  });
  readonly health = new ConstantHealthSource();

  async dispose(): Promise<void> {
    await this.files.dispose();
    await this.git.dispose();
    await this.watcher.dispose();
    await this.scope.dispose();
  }
}

async function probeGitDependency(): Promise<void> {
  try {
    const manager = await getDependencyManager();
    await manager.probe('git');
  } catch (error) {
    log.warn('RuntimeManager: Git dependency probe failed', {
      error: String(error),
    });
  }
}

class DefaultRuntimeManager implements RuntimeManager {
  private readonly runtimes = new ResourceMap<MachineRuntime>({
    teardown: (_key, runtime) => runtime.dispose(),
    onError: (context, error) =>
      log.warn('RuntimeManager: runtime teardown failed', { context, error: String(error) }),
  });

  acquire(): Promise<Lease<MachineRuntime>> {
    return this.runtimes.acquire('local', async () => {
      await probeGitDependency();
      return new LocalMachineRuntime();
    });
  }

  async dispose(): Promise<void> {
    await this.runtimes.dispose();
  }
}

export const runtimeManager = new DefaultRuntimeManager();
