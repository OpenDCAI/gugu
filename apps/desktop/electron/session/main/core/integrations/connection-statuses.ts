import { integrationPluginRegistry } from '@gugu/session-plugins/integrations';
import type { IssueProvider } from '@main/core/issues/issue-provider';
import { getIssueProvider } from '@main/core/issues/registry';
import type { ConnectionStatus, IssueProviderCapabilities, IssueProviderType } from '@shared/issue-providers';
import { integrationConnectionService } from './integration-connection-service';
import { integrationCredentialStore } from './integration-credential-store-instance';

/** 一家集成「连没连上」从哪读:issue 系统走它的 issue provider(GitHub 的多账号在那),其余直接问凭据。 */
export type ConnectionSource = Pick<IssueProvider, 'capabilities' | 'checkConnection' | 'isConfigured'>;

const CONNECTION_CHECK_TIMEOUT_MS = 8_000;

/** 不是 issue 系统的集成(飞书、腾讯文档、滴答清单…):没有工单能力可言。 */
const NO_ISSUE_CAPABILITIES: IssueProviderCapabilities = {
  requiresRepositoryUrl: false,
  supportsIssueContext: false,
};

export async function checkSourceConnection(source: ConnectionSource): Promise<ConnectionStatus> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ConnectionStatus>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        connected: false,
        error: `Connection check timed out after ${CONNECTION_CHECK_TIMEOUT_MS}ms.`,
        capabilities: source.capabilities,
      });
    }, CONNECTION_CHECK_TIMEOUT_MS);
  });

  try {
    return await Promise.race([source.checkConnection(), timeout]);
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Connection check failed.',
      capabilities: source.capabilities,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function checkSourceConfigured(source: ConnectionSource): Promise<boolean> {
  if (!source.isConfigured) return (await checkSourceConnection(source)).connected;
  try {
    return await source.isConfigured();
  } catch {
    return false;
  }
}

function connectionSource(integrationId: string): ConnectionSource {
  const issueProvider = getIssueProvider(integrationId as IssueProviderType);
  if (issueProvider) return issueProvider;
  return {
    capabilities: NO_ISSUE_CAPABILITIES,
    checkConnection: () => integrationConnectionService.checkConnection(integrationId, NO_ISSUE_CAPABILITIES),
    isConfigured: () => integrationCredentialStore.isConfigured(integrationId),
  };
}

/**
 * 资源库那一页要的「每一家连没连上」—— **注册表里的每一家**,不只是 issue 系统(#7210)。
 * 此前这两问挂在 `issues.*` 上,只认 issue provider,于是不是 issue 系统的集成在资源库里根本画不出来。
 */
export async function checkAllIntegrationConnections(): Promise<Record<string, ConnectionStatus>> {
  const settled = await Promise.all(
    integrationPluginRegistry.getAll().map(async (plugin) => {
      const id = plugin.metadata.id;
      return [id, await checkSourceConnection(connectionSource(id))] as const;
    })
  );
  return Object.fromEntries(settled);
}

export async function checkConfiguredIntegrations(): Promise<Record<string, boolean>> {
  const settled = await Promise.all(
    integrationPluginRegistry.getAll().map(async (plugin) => {
      const id = plugin.metadata.id;
      return [id, await checkSourceConfigured(connectionSource(id))] as const;
    })
  );
  return Object.fromEntries(settled);
}
