import type { ITrustBehavior } from '@gugu/session-core/agents/plugins';
import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { appSettingsService } from '@main/core/settings/settings-service';
import { log } from '@main/lib/logger';
import { getPlugin } from './plugin-registry';
import { prepareAgentFirstRunState } from './agent-home';
import { resolveTrustTarget, type WorkspaceTrustHost } from './workspace-trust-target';

export type WorkspaceTrustArgs = {
  providerId: AgentProviderId;
  workspacePath: string;
  host: WorkspaceTrustHost;
  force?: boolean;
  autoApprove?: boolean;
};

type WorkspaceTrustDeps = {
  getSessionSettings: () => Promise<{ autoTrustWorktrees: boolean }>;
  getTrustBehavior: (providerId: AgentProviderId) => ITrustBehavior | undefined;
};

/**
 * 这一次 spawn 因「工作区可信」要多带的 env 与 argv。没有可带的就是空对象/空数组,
 * ❌ 不返回 undefined。`args` 由调用方追加到本次命令行**尾部**。
 */
export type WorkspaceTrustOutcome = {
  env: Readonly<Record<string, string>>;
  args: readonly string[];
};

const NO_TRUST_ENV: WorkspaceTrustOutcome = { env: {}, args: [] };

export class WorkspaceTrustService {
  private readonly homeLocks = new Map<string, Promise<void>>();

  constructor(private readonly deps: WorkspaceTrustDeps) {}

  /**
   * 让这一家的 CLI 跳过它的信任提示。怎么跳由这一家的 `trust.channel` 决定
   * (`capabilities/trust.ts`):`runtime-env` / `runtime-argv` 只回一份 env / argv 给调用方
   * 合进 spawn;`config-file` / `first-run-state` 在这里落盘。No-op unless the provider has a trust
   * behavior and auto-trust is enabled (or `force` is set, e.g. for auto-approve runs).
   */
  async maybeAutoTrust({
    providerId,
    workspacePath,
    host,
    force = false,
    autoApprove = false,
  }: WorkspaceTrustArgs): Promise<WorkspaceTrustOutcome> {
    const behavior = this.deps.getTrustBehavior(providerId);
    if (!behavior) return NO_TRUST_ENV;
    if (!(await this.shouldAutoTrust(force))) return NO_TRUST_ENV;

    if (behavior.channel === 'runtime-env') {
      // 不落地:这一家没有独立 home 要铺、也没有文件要写。路径合法性由 spawn 自己判。
      return { env: behavior.trustEnv({ workspacePath, autoApprove }), args: [] };
    }
    if (behavior.channel === 'runtime-argv') {
      // 同上一档,只是载体是命令行旗标(mimocode:`--trust`)。
      return { env: {}, args: behavior.trustArgs({ workspacePath, autoApprove }) };
    }

    const isolatedRoot = await prepareAgentFirstRunState(providerId, workspacePath).catch((error: unknown) => {
      log.warn('WorkspaceTrust: failed to prepare isolated first-run state', {
        providerId,
        path: workspacePath,
        error: String(error),
      });
      return null;
    });
    if (isolatedRoot === null) return NO_TRUST_ENV;

    // 托管配置根的家:descriptor first-run state 是唯一写者,上面那一步已经写完。
    if (behavior.channel === 'first-run-state') return NO_TRUST_ENV;

    const target = await resolveTrustTarget(host, workspacePath, isolatedRoot ?? undefined);
    if (!target) return NO_TRUST_ENV;

    await this.withHomeLock(target.lockKey, async () => {
      try {
        await behavior.trustWorkspace(target.fs, {
          workspacePath: target.workspacePath,
          autoApprove,
        });
      } catch (error: unknown) {
        log.warn('WorkspaceTrust: failed to auto-trust worktree', {
          providerId,
          path: target.workspacePath,
          error: String(error),
        });
      }
    });
    return NO_TRUST_ENV;
  }

  private async shouldAutoTrust(force: boolean): Promise<boolean> {
    if (force) return true;
    const { autoTrustWorktrees } = await this.deps.getSessionSettings();
    return autoTrustWorktrees;
  }

  /**
   * Serialize trust writes per home directory: trust configs are shared
   * read-merge-write files, so concurrent writers would lose updates.
   */
  private withHomeLock(lockKey: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.homeLocks.get(lockKey) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.homeLocks.set(lockKey, next);
    return next;
  }
}

export const workspaceTrustService = new WorkspaceTrustService({
  getSessionSettings: () => appSettingsService.get('sessions'),
  getTrustBehavior: (providerId) => getPlugin(providerId).behavior.trust,
});
