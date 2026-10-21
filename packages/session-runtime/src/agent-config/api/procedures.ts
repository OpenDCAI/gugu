import type { AgentRunContext } from '@gugu/session-core/acp';
import type {
  AgentAuthStatus,
  HarnessModelCredentialStatus,
  SubscriptionPlanReading,
  SubscriptionUsageReading,
} from '@gugu/session-core/agents/plugins';
import type { McpServer } from '@gugu/session-core/mcp';
import type {
  AgentConfigAuthError,
  AgentConfigMcpError,
  AgentConfigRefreshError,
  AgentUninstallError,
  DependencyState,
  HostDependencyLedgerSnapshotDTO,
} from '@gugu/session-core/workspace-server';
import { err, type Result } from '@gugu/session-shared';
import type { AgentConfigRuntime } from '../runtime/runtime';

export function createAgentConfigProcedures(runtime: AgentConfigRuntime) {
  return {
    // The owning host implements these operations; workers never store credentials.
    listConnections: unsupportedConnectionOperation,
    createConnection: unsupportedConnectionOperation,
    selectConnection: unsupportedConnectionOperation,
    removeConnection: unsupportedConnectionOperation,
    refreshAgents(input: {
      providerId?: string;
      refreshShellEnv?: boolean;
    }): Promise<Result<void, AgentConfigRefreshError>> {
      return runtime.refreshAgents(input);
    },
    syncHostDependencyLedger(
      input: HostDependencyLedgerSnapshotDTO
    ): Promise<Result<void, AgentConfigRefreshError>> {
      return runtime.syncHostDependencyLedger(input);
    },
    uninstallAgent(input: {
      providerId: string;
      strategy?: { kind: 'package-manager'; method?: string };
    }): Promise<Result<DependencyState, AgentUninstallError>> {
      return runtime.uninstallAgent(input.providerId, input.strategy);
    },
    // 登录这一组都带 `program`(#6335):缺席 = 主程序。
    startLogin(input: {
      providerId: string;
      methodId: string;
      program?: string;
      connectionId?: string;
      runContext: AgentRunContext;
      headless?: boolean;
    }): Promise<Result<void, AgentConfigAuthError>> {
      return runtime.startLogin(input.providerId, input.methodId, input.runContext, input.program, {
        headless: input.headless,
      }, input.connectionId);
    },
    cancelLogin(input: { providerId: string; program?: string; connectionId?: string }): Promise<Result<void, AgentConfigAuthError>> {
      return runtime.cancelLogin(input.providerId, input.program, input.connectionId);
    },
    sendLoginInput(input: {
      providerId: string;
      program?: string;
      connectionId?: string;
      data: string;
    }): Result<void, AgentConfigAuthError> {
      return runtime.sendLoginInput(input.providerId, input.data, input.program, input.connectionId);
    },
    resizeLogin(input: {
      providerId: string;
      program?: string;
      connectionId?: string;
      cols: number;
      rows: number;
    }): Result<void, AgentConfigAuthError> {
      return runtime.resizeLogin(input.providerId, input.cols, input.rows, input.program, input.connectionId);
    },
    markUrlHandled(input: {
      providerId: string;
      program?: string;
      connectionId?: string;
      urlId: string;
    }): Result<void, AgentConfigAuthError> {
      return runtime.markUrlHandled(input.providerId, input.urlId, input.program, input.connectionId);
    },
    refreshAuthStatus(input: {
      providerId: string;
      program?: string;
      connectionId?: string;
      runContext: AgentRunContext;
    }): Promise<Result<AgentAuthStatus, AgentConfigAuthError>> {
      return runtime.refreshAuthStatus(input.providerId, input.runContext, input.program, input.connectionId);
    },
    modelCredential(input: {
      providerId: string;
      modelId: string;
      runContext: AgentRunContext;
    }): Promise<Result<HarnessModelCredentialStatus, AgentConfigAuthError>> {
      return runtime.modelCredential(input.providerId, input.modelId, input.runContext);
    },
    readSubscription(input: {
      providerId: string;
      runContext: AgentRunContext;
    }): Promise<Result<SubscriptionPlanReading, AgentConfigAuthError>> {
      return runtime.readSubscription(input.providerId, input.runContext);
    },
    readSubscriptionUsage(input: {
      providerId: string;
      force?: boolean;
      runContext: AgentRunContext;
    }): Promise<Result<SubscriptionUsageReading, AgentConfigAuthError>> {
      return runtime.readSubscriptionUsage(input.providerId, input.runContext, input.force === true);
    },
    markAuthExpired(input: { providerId: string; connectionId?: string }): Promise<Result<void, AgentConfigAuthError>> {
      return runtime.markAuthExpired(input.providerId, input.connectionId);
    },
    clearAuthExpired(input: { providerId: string; connectionId?: string }): Promise<Result<void, AgentConfigAuthError>> {
      return runtime.clearAuthExpired(input.providerId, input.connectionId);
    },
    saveMcpServer(input: { server: McpServer }): Promise<Result<void, AgentConfigMcpError>> {
      return runtime.saveMcpServer(input.server);
    },
    removeMcpServer(input: { name: string }): Promise<Result<void, AgentConfigMcpError>> {
      return runtime.removeMcpServer(input.name);
    },
    listMcpForAgent(input: {
      providerId: string;
    }): Promise<Result<McpServer[], AgentConfigMcpError>> {
      return runtime.listMcpForAgent(input.providerId);
    },
  };
}

export type AgentConfigProcedures = ReturnType<typeof createAgentConfigProcedures>;

function unsupportedConnectionOperation(): Result<never, AgentConfigAuthError> {
  return err({ type: 'invalid-state', message: 'Connection management requires the credential-owning host' });
}
