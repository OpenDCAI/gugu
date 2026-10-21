import type { Pty } from '@main/core/pty/pty';

type SessionSpawnToken = {
  mode: SessionSpawnMode;
  /**
   * 这次启动的寿命(#6183)。启动路上没有墙钟 ⇒ 放弃等待只有 `cancelStart()` 这一个入口
   * (显式停止会话时调用):它 abort 这个信号,仍在跑的版本探针随之被收掉,启动以「被取消」结束。
   */
  signal: AbortSignal;
};

type SpawnInFlight = SessionSpawnToken & { abort: AbortController };

type SessionSpawnMode = 'fresh' | 'resume';

type ActiveSessionPty = {
  pty: Pty;
  mode: SessionSpawnMode;
};

type SessionRuntime = {
  desired: boolean;
  active?: ActiveSessionPty;
  spawnInFlight?: SpawnInFlight;
};

export type ExitDecision =
  | { kind: 'stale' }
  | { kind: 'stopped' }
  | { kind: 'failed' }
  | { kind: 'respawnResume' };

export class SessionPtySupervisor {
  private runtimesByPtySession = new Map<string, SessionRuntime>();

  beginStart(
    ptySessionId: string,
    options: { requireDesired?: boolean; mode?: SessionSpawnMode } = {}
  ): SessionSpawnToken | undefined {
    const runtime = this.getOrCreateRuntime(ptySessionId);
    if (runtime.active || runtime.spawnInFlight) return undefined;
    if (options.requireDesired === true && !runtime.desired) return undefined;

    runtime.desired = true;
    const mode = options.mode ?? 'fresh';
    const abort = new AbortController();
    const token: SpawnInFlight = {
      mode,
      signal: abort.signal,
      abort,
    };
    runtime.spawnInFlight = token;
    return token;
  }

  acceptSpawn(ptySessionId: string, token: SessionSpawnToken, pty: Pty): boolean {
    const runtime = this.runtimesByPtySession.get(ptySessionId);
    if (!runtime || runtime.spawnInFlight !== token) return false;

    runtime.spawnInFlight = undefined;
    if (!runtime.desired) return false;

    runtime.active = {
      pty,
      mode: token.mode,
    };
    return true;
  }

  failSpawn(ptySessionId: string, token: SessionSpawnToken): boolean {
    const runtime = this.runtimesByPtySession.get(ptySessionId);
    if (!runtime || runtime.spawnInFlight !== token) return false;
    runtime.spawnInFlight = undefined;
    return true;
  }

  stop(ptySessionId: string): Pty | undefined {
    const runtime = this.runtimesByPtySession.get(ptySessionId);
    if (!runtime) return undefined;

    runtime.desired = false;
    runtime.spawnInFlight = undefined;

    const pty = runtime.active?.pty;
    runtime.active = undefined;
    return pty;
  }

  /**
   * 显式停止会话时取消在飞的那次启动(#6183)。❌ 放进 `stop()`:detach / 收起 / 内部失败路径也走 stop,
   * 它们不是「用户取消了启动」,不该让等启动的一方收到一个「已取消」。
   */
  cancelStart(ptySessionId: string): boolean {
    const inFlight = this.runtimesByPtySession.get(ptySessionId)?.spawnInFlight;
    if (!inFlight) return false;
    inFlight.abort.abort(new Error('the session start was cancelled by stopping the session'));
    return true;
  }

  /** 此刻有没有一次在飞的启动。 */
  hasStartInFlight(ptySessionId: string): boolean {
    return this.runtimesByPtySession.get(ptySessionId)?.spawnInFlight !== undefined;
  }

  isDesired(ptySessionId: string): boolean {
    return this.runtimesByPtySession.get(ptySessionId)?.desired === true;
  }

  handleExit(ptySessionId: string, pty: Pty): ExitDecision {
    const runtime = this.runtimesByPtySession.get(ptySessionId);
    if (!runtime || runtime.active?.pty !== pty) return { kind: 'stale' };

    const exitedMode = runtime.active.mode;
    runtime.active = undefined;
    runtime.spawnInFlight = undefined;

    if (!runtime.desired) return { kind: 'stopped' };

    if (exitedMode === 'resume') {
      runtime.desired = false;
      return { kind: 'failed' };
    }

    return { kind: 'respawnResume' };
  }

  forget(ptySessionId: string): void {
    this.runtimesByPtySession.delete(ptySessionId);
  }

  private getOrCreateRuntime(ptySessionId: string): SessionRuntime {
    let runtime = this.runtimesByPtySession.get(ptySessionId);
    if (!runtime) {
      runtime = {
        desired: false,
      };
      this.runtimesByPtySession.set(ptySessionId, runtime);
    }
    return runtime;
  }
}
