import {
  type DependencyState,
  type HostDependencyManager,
} from '@gugu/session-core/deps/runtime';
import type {
  AgentConfigEntry,
  AgentConfigList,
  AgentConfigRefreshError,
  AgentInstallError,
  AgentInstallProgress,
  AgentUninstallError,
} from '@gugu/session-core/workspace-server';
import { err, ok, type Result } from '@gugu/session-shared';
import type { LiveJobContext } from '@gugu/session-wire';
import type { AgentConfigAgentsModel } from '../state/live-models';
import { publishLiveModelState } from '../state/live-models';
import type { AgentConfigRuntimeDeps } from './types';

type InstallStrategy = { kind: 'package-manager'; method?: string };
type UninstallStrategy = { kind: 'package-manager'; method?: string };

/**
 * 无头 runtime 里**没有**安装通道:托管安装靠的是随桌面端打包的那份 mise,它不在这个进程里。
 *
 * ❌ 这里曾经有两条腿:一条 `$SHELL -lc` 的直装 runner,一条绕过 `HostDependencyManager`
 * 的 `custom` 自定义命令。两条都删了(#6098)—— 一台机器上两套「装没装」的口径,正是
 * worker 侧 `ours` 恒 false、用户选的那一份看不见这类不一致的根。
 * ⇒ 这里如实说「这儿装不了」,❌ 不许再折成 `command-failed`。
 */
const NO_INSTALL_CHANNEL = {
  type: 'unsupported-host' as const,
  message: 'Installing agents needs the Gugu desktop app running on this computer.',
};

export class AgentInstallManager {
  private readonly manager: HostDependencyManager;
  private readonly providersById: Map<
    string,
    ReturnType<AgentConfigRuntimeDeps['agentHost']['getAll']>[number]
  >;
  private list: AgentConfigList = {};

  constructor(
    private readonly deps: AgentConfigRuntimeDeps,
    private readonly agentsModel: AgentConfigAgentsModel
  ) {
    const providers = deps.agentHost.getAll();
    this.providersById = new Map(providers.map((provider) => [provider.metadata.id, provider]));
    this.manager = deps.agentHost.dependencies;
    // ❌ 这里不再作废任何派生缓存(#5702)。worker 侧已经**没有**自己算的 cli / env 副本了 ——
    //    每次调用都从宿主递进来的 `AgentRunContext` 拿,装完卸完自然就是新的一份。
    this.manager.onStatusUpdated.subscribe((event) => {
      // 伴随程序(#6335,`antigravity-cli`)在账上是自己一行,但这张名单按**插件**列 ——
      // ❌ 不给它编一个名叫 `antigravity-cli` 的「插件」条目。它装没装由桌面端按腿合并去说。
      if (!this.providersById.has(event.id)) return;
      this.updateInstall(event.id, event.state);
    });
    this.seedProviders();
  }

  initialize(): void {
    this.manager.initialize();
  }

  async refresh(input: {
    providerId?: string;
    refreshShellEnv?: boolean;
  }): Promise<Result<void, AgentConfigRefreshError>> {
    if (input.providerId) {
      if (!this.providersById.has(input.providerId)) {
        return err({ type: 'unknown-provider' as const, providerId: input.providerId });
      }
      await this.manager.probe(input.providerId);
      return ok();
    }
    await this.manager.probeCategory('agent', { refreshShellEnv: input.refreshShellEnv });
    return ok();
  }

  async install(
    providerId: string,
    _strategy: InstallStrategy,
    _ctx: LiveJobContext<AgentInstallProgress>
  ): Promise<Result<DependencyState, AgentInstallError>> {
    if (!this.providersById.has(providerId)) {
      return err({ type: 'unknown-provider', providerId });
    }
    return err(NO_INSTALL_CHANNEL);
  }

  async uninstall(
    providerId: string,
    _strategy?: UninstallStrategy
  ): Promise<Result<DependencyState, AgentUninstallError>> {
    if (!this.providersById.has(providerId)) {
      return err({ type: 'unknown-provider', providerId });
    }
    // 卸载与安装同源:咕咕没装过的东西它也拆不掉,这个进程里连执行器都没有。
    return err(NO_INSTALL_CHANNEL);
  }

  /** `program` 缺席 = 主程序那一格(`auth`);给了 = 伴随程序那一格(`programAuth[program]`,#6335)。 */
  updateAuth(providerId: string, auth: AgentConfigEntry['auth'], program?: string, connectionId?: string): void {
    const current = this.entry(providerId);
    this.publish({
      ...this.list,
      [providerId]:
        connectionId
          ? { ...current, connectionAuth: { ...current.connectionAuth, [connectionId]: auth } }
          : program === undefined
          ? { ...current, auth }
          : { ...current, programAuth: { ...current.programAuth, [program]: auth } },
    });
  }

  getAuth(providerId: string, program?: string, connectionId?: string): AgentConfigEntry['auth'] {
    const entry = this.entry(providerId);
    if (connectionId) return entry.connectionAuth?.[connectionId] ?? { status: { kind: 'unknown' }, login: null };
    if (program === undefined) return entry.auth;
    return entry.programAuth?.[program] ?? { status: { kind: 'unknown' }, login: null };
  }

  dispose(): void {
    // The machine-scoped AgentPluginHost owns execution-context disposal through its scope.
  }

  private seedProviders(): void {
    const now = Date.now();
    const list: AgentConfigList = {};
    for (const provider of this.deps.agentHost.getAll()) {
      const id = provider.metadata.id;
      list[id] = {
        providerId: id,
        name: provider.metadata.name,
        install: {
          id,
          category: 'agent',
          status: 'missing',
          version: null,
          path: null,
          checkedAt: now,
        },
        auth: { status: { kind: 'unknown' }, login: null },
        installOptions: this.manager.getInstallOptions(id),
      };
    }
    this.publish(list);
  }

  private updateInstall(providerId: string, install: DependencyState): void {
    const current = this.entry(providerId);
    this.publish({
      ...this.list,
      [providerId]: { ...current, install },
    });
  }

  private entry(providerId: string): AgentConfigEntry {
    const existing = this.list[providerId];
    if (existing) return existing;
    const provider = this.providersById.get(providerId);
    return {
      providerId,
      name: provider?.metadata.name ?? providerId,
      install: {
        id: providerId,
        category: 'agent',
        status: 'missing',
        version: null,
        path: null,
        checkedAt: Date.now(),
      },
      auth: { status: { kind: 'unknown' }, login: null },
      installOptions: this.manager.getInstallOptions(providerId),
    };
  }

  private publish(list: AgentConfigList): void {
    const previous = this.list;
    this.list = list;
    publishLiveModelState(this.agentsModel.states.list, list, previous);
  }
}
