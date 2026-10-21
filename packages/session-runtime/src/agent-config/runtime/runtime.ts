import { agentRunContextKey, type AgentRunContext } from '@gugu/session-core/acp';
import type {
  AgentAuthStatus,
  HarnessModelCredentialStatus,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import type { McpServer } from '@gugu/session-core/mcp';
import type { HostDependencyLedgerSnapshot } from '@gugu/session-core/deps/runtime';
import type {
  AgentConfigAuthError,
  AgentConfigMcpError,
  AgentConfigRefreshError,
  AgentInstallError,
  AgentInstallProgress,
  AgentUninstallError,
  DependencyState,
} from '@gugu/session-core/workspace-server';
import { err, ok, type Result } from '@gugu/session-shared';
import type { LiveJobContext } from '@gugu/session-wire';
import type { LiveLog } from '@gugu/session-wire';
import {
  createAgentConfigAgentsLiveHost,
  createAgentConfigAgentsModel,
  createAgentConfigMcpLiveHost,
  createAgentConfigMcpModel,
  type AgentConfigAgentsLiveHost,
  type AgentConfigMcpLiveHost,
} from '../state/live-models';
import { AgentAuthManager } from './auth';
import { authExpiryKey } from './auth';
import { applyCredentialExpiry } from './auth-expiry';
import { AgentInstallManager } from './install';
import { AgentMcpConfigManager } from './mcp';
import type { AgentConfigRuntimeDeps } from './types';

type InstallStrategy = { kind: 'package-manager'; method?: string };
type UninstallStrategy = { kind: 'package-manager'; method?: string };

export class AgentConfigRuntime {
  private readonly agentsHost = createAgentConfigAgentsLiveHost();
  private readonly mcpHost = createAgentConfigMcpLiveHost();
  private readonly agentsModel = createAgentConfigAgentsModel(this.agentsHost);
  private readonly mcpModel = createAgentConfigMcpModel(this.mcpHost);

  readonly install: AgentInstallManager;
  readonly auth: AgentAuthManager;
  readonly mcp: AgentMcpConfigManager;

  constructor(private readonly deps: AgentConfigRuntimeDeps) {
    this.install = new AgentInstallManager(deps, this.agentsModel);
    this.auth = new AgentAuthManager(deps, this.install);
    this.mcp = new AgentMcpConfigManager(deps, this.mcpModel);
    this.deps.scope.add(async () => {
      await this.auth.dispose();
      this.install.dispose();
      this.agentsHost.dispose();
      this.mcpHost.dispose();
    });
    this.install.initialize();
    void this.mcp.initialize();
  }

  agentsLiveHost(): AgentConfigAgentsLiveHost {
    return this.agentsHost;
  }

  mcpLiveHost(): AgentConfigMcpLiveHost {
    return this.mcpHost;
  }

  refreshAgents(input: {
    providerId?: string;
    refreshShellEnv?: boolean;
  }): Promise<Result<void, AgentConfigRefreshError>> {
    return this.install.refresh(input);
  }

  /**
   * 收下主进程那本账并**立刻重探一遍**(#6101)。
   *
   * 重探不是可选的:账换了(用户改了选择、咕咕装完写了记录),上一轮读数就是按旧账算的 ——
   * 留着它等于把两套读数里旧的那套继续报出去。
   */
  async syncHostDependencyLedger(
    snapshot: HostDependencyLedgerSnapshot
  ): Promise<Result<void, AgentConfigRefreshError>> {
    const ledger = this.deps.hostDependencyLedger;
    if (!ledger) {
      return err({
        type: 'invalid-state' as const,
        message: 'This runtime was started without a host-dependency ledger replica.',
      });
    }
    ledger.apply(snapshot);
    return this.install.refresh({});
  }

  installAgent(
    providerId: string,
    strategy: InstallStrategy,
    ctx: LiveJobContext<AgentInstallProgress>
  ): Promise<Result<DependencyState, AgentInstallError>> {
    return this.install.install(providerId, strategy, ctx);
  }

  uninstallAgent(
    providerId: string,
    strategy?: UninstallStrategy
  ): Promise<Result<DependencyState, AgentUninstallError>> {
    return this.install.uninstall(providerId, strategy);
  }

  refreshAuthStatus(
    providerId: string,
    runContext: AgentRunContext,
    program?: string,
    connectionId?: string
  ): Promise<Result<AgentAuthStatus, AgentConfigAuthError>> {
    return this.auth.refreshAuthStatus(providerId, runContext, program, connectionId);
  }

  /**
   * 「这家自报的某个自家模型,其 provider 在本机有没有凭据」(product spec 默认预选规则)。
   *
   * 宿主层判不出(没实现该行为 / 读数失败)一律 `'unknown'` —— 那不是错误,是读数本身:
   * 消费方对 `'unknown'` 必须维持这家自家默认。只有「没有这个 provider」才走错误通道。
   */
  async modelCredential(
    providerId: string,
    modelId: string,
    runContext: AgentRunContext
  ): Promise<Result<HarnessModelCredentialStatus, AgentConfigAuthError>> {
    if (!this.deps.agentHost.get(providerId)) return err({ type: 'unknown-provider', providerId });
    const result = await this.deps.agentHost.modelCredential(providerId, modelId, runContext);
    if (!result.success) {
      this.deps.logger.warn('AgentConfigRuntime: modelCredential resolution failed', {
        providerId,
        modelId,
        error: result.error,
      });
      return ok('unknown');
    }
    // 登录已失效(#6264):CLI 照文件答「有凭据」,可这份凭据真用时被拒了。
    await this.auth.expiry.reload();
    return ok(applyCredentialExpiry(result.data, this.auth.expiry.has(authExpiryKey(providerId, runContext.connectionId))));
  }

  /**
   * 「订阅」页的读数(product spec)。插件层判不出就是判不出(`unknown` / `unavailable`),
   * 那不是错误;只有「没有这个 provider」与「宿主定不出 CLI」走错误通道。
   */
  async readSubscription(
    providerId: string,
    runContext: AgentRunContext
  ): Promise<Result<SubscriptionPlanReading, AgentConfigAuthError>> {
    if (!this.deps.agentHost.get(providerId)) return err({ type: 'unknown-provider', providerId });
    const result = await this.deps.agentHost.readSubscription(providerId, runContext);
    if (!result.success) {
      this.deps.logger.warn('AgentConfigRuntime: readSubscription failed', { providerId, error: result.error });
      return ok({ payer: 'unknown', message: hostErrorMessage(result.error) });
    }
    return ok(result.data);
  }

  /**
   * 用量。声明了 `usageRefresh: 'on-demand'` 的家(Claude:厂商那个查询问几次就会被封一阵)只在 `force`
   * 时真去问;平时答上一次问到的那份(带它自己的 `readAt`),从没问过就答 `not-read-yet`。
   * 记在这个进程里:咕咕重启后要再点一次「现在查」—— ❌ 为了省这一下去落盘一份会过期的额度。
   */
  async readSubscriptionUsage(
    providerId: string,
    runContext: AgentRunContext,
    force: boolean
  ): Promise<Result<SubscriptionUsageReading, AgentConfigAuthError>> {
    const provider = this.deps.agentHost.get(providerId);
    if (!provider) return err({ type: 'unknown-provider', providerId });
    const descriptor = provider.capabilities.subscription;
    const onDemand = descriptor.kind === 'supported' && descriptor.usageRefresh === 'on-demand';
    const mark = (reading: SubscriptionUsageReading): SubscriptionUsageReading =>
      onDemand ? { ...reading, onDemand: true } : reading;
    const usageKey = `${providerId}\u0000${agentRunContextKey(runContext)}`;
    const revision = this.usageRevisions.get(usageKey) ?? 0;
    if (onDemand && !force) {
      return ok(mark(this.lastUsage.get(usageKey) ?? { kind: 'unavailable', reason: 'not-read-yet', readAt: Date.now() }));
    }
    const pendingKey = `${usageKey}\u0000${revision}`;
    let request = this.usageRequests.get(pendingKey);
    if (!request) {
      request = this.deps.agentHost.readSubscriptionUsage(providerId, runContext).catch((error: unknown) =>
        err({ type: 'invalid-state' as const, message: hostErrorMessage(error) }));
      this.usageRequests.set(pendingKey, request);
    }
    const result = await request.finally(() => {
      if (this.usageRequests.get(pendingKey) === request) this.usageRequests.delete(pendingKey);
    });
    if (revision !== (this.usageRevisions.get(usageKey) ?? 0)) {
      return ok(mark({ kind: 'unavailable', reason: 'not-read-yet', readAt: Date.now() }));
    }
    if (!result.success) {
      this.deps.logger.warn('AgentConfigRuntime: readSubscriptionUsage failed', { providerId, error: result.error });
    }
    const reading: SubscriptionUsageReading = result.success ? result.data
      : { kind: 'unavailable', reason: 'error', message: hostErrorMessage(result.error), readAt: Date.now() };
    const previous = this.lastUsage.get(usageKey);
    if (reading.kind === 'unavailable' && reading.reason === 'error' && previous?.kind === 'windows') {
      return ok(mark({ ...previous, refreshError: reading.message ?? '额度刷新失败。' }));
    }
    this.lastUsage.set(usageKey, reading);
    return ok(mark(reading));
  }

  private readonly lastUsage = new Map<string, SubscriptionUsageReading>();
  private readonly usageRevisions = new Map<string, number>();
  private readonly usageRequests = new Map<string, ReturnType<AgentConfigRuntimeDeps['agentHost']['readSubscriptionUsage']>>();

  markAuthExpired(providerId: string, connectionId?: string): Promise<Result<void, AgentConfigAuthError>> {
    return this.auth.markExpired(providerId, connectionId);
  }

  clearAuthExpired(providerId: string, connectionId?: string): Promise<Result<void, AgentConfigAuthError>> {
    return this.auth.clearExpired(providerId, connectionId);
  }

  // 登录这一组的 `program`:缺席 = 主程序,给了 = 那个伴随程序(#6335,见 `authKey`)。
  async startLogin(
    providerId: string,
    methodId: string,
    runContext: AgentRunContext,
    program?: string,
    options: { headless?: boolean } = {},
    connectionId?: string
  ): Promise<Result<void, AgentConfigAuthError>> {
    // A subscription login must never reuse the native profile or overwrite a signed-in connection.
    // Check before invalidating quota or releasing a login lease: even a stale renderer must be harmless.
    const targetConnection = connectionId ?? runContext.connectionId;
    if ((providerId === 'claude' || providerId === 'codex') && targetConnection) {
      if (targetConnection === 'native') {
        return err({ type: 'invalid-state', message: '现有 CLI 配置不支持在这里重新登录。请添加独立账号连接，原登录会保留。' });
      }
      const status = await this.deps.agentHost.checkAuthStatus(providerId, runContext, program);
      if (!status.success) return err({ type: 'invalid-state', message: hostErrorMessage(status.error) });
      if (status.data.kind === 'authenticated') {
        return err({ type: 'invalid-state', message: '这个连接已经登录。请添加独立账号连接，原登录会保留。' });
      }
    }
    const usageKey = `${providerId}\u0000${agentRunContextKey(runContext)}`;
    this.lastUsage.delete(usageKey);
    this.usageRevisions.set(usageKey, (this.usageRevisions.get(usageKey) ?? 0) + 1);
    return this.auth.startLogin(providerId, methodId, runContext, program, options, connectionId);
  }

  cancelLogin(providerId: string, program?: string, connectionId?: string): Promise<Result<void, AgentConfigAuthError>> {
    return this.auth.cancelLogin(providerId, program, connectionId);
  }

  sendLoginInput(providerId: string, data: string, program?: string, connectionId?: string): Result<void, AgentConfigAuthError> {
    return this.auth.sendLoginInput(providerId, data, program, connectionId);
  }

  resizeLogin(
    providerId: string,
    cols: number,
    rows: number,
    program?: string,
    connectionId?: string
  ): Result<void, AgentConfigAuthError> {
    return this.auth.resizeLogin(providerId, cols, rows, program, connectionId);
  }

  markUrlHandled(providerId: string, urlId: string, program?: string, connectionId?: string): Result<void, AgentConfigAuthError> {
    return this.auth.markUrlHandled(providerId, urlId, program, connectionId);
  }

  loginOutputLog(providerId: string, program?: string, connectionId?: string): LiveLog | null {
    return this.auth.loginOutput(providerId, program, connectionId);
  }

  saveMcpServer(server: McpServer): Promise<Result<void, AgentConfigMcpError>> {
    return this.mcp.saveServer(server);
  }

  removeMcpServer(name: string): Promise<Result<void, AgentConfigMcpError>> {
    return this.mcp.removeServer(name);
  }

  listMcpForAgent(providerId: string): Promise<Result<McpServer[], AgentConfigMcpError>> {
    return this.mcp.listForAgent(providerId);
  }

  dispose(): Promise<void> {
    return this.deps.scope.dispose();
  }
}

function hostErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}
