import { integrationPluginRegistry, mcpOAuthCredentialsSchema } from '@gugu/session-plugins/integrations';
import type { IntegrationUpstream } from '../../../../integration-mcp-bridge';
import { integrationCredentialStore } from './integration-credential-store-instance';
import { integrationConnectionService } from './integration-connection-service';
import { isMailIntegration, mailIntegrationTools } from './mail/mail-tools';
import type { PlatformCredentialService } from './platform-credentials';
import { platformCredentials } from './platform-credentials-instance';

/**
 * 一家已连接、能以 MCP 工具交给 agent 的集成 —— 会话里给 agent 的就是这些。
 * 托管 MCP 那几家转发给对方(`remote`);凭据由平台保管的(高德,#921)转发给平台的转发口(也是 `remote`);
 * 邮箱由咕咕自己答(`local`,#7240)。
 */
export type SessionIntegration = {
  integrationId: string;
  upstream: IntegrationUpstream;
};

function mcpOAuthServerUrl(integrationId: string): string | null {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  const method = methods.find((candidate) => candidate.kind === 'mcp-oauth');
  return method?.kind === 'mcp-oauth' ? method.serverUrl : null;
}

/** Whether a connected integration hands an agent anything to call in a session: mail tools or a hosted MCP. */
export function integrationGivesSessionTools(integrationId: string): boolean {
  return isMailIntegration(integrationId) || mcpOAuthServerUrl(integrationId) !== null;
}

/**
 * 新开一条会话时,哪些集成该递给 agent。
 *
 * 判据只有两条:这家能以工具交出去(托管 MCP / 邮箱),且**当下真的连着**。❌ 别把「装了这个插件」当成连着 ——
 * 那会给 agent 一台连不上的 server,而工具清单一旦进了模型前缀就改不了了。
 */
export async function connectedSessionIntegrations(
  platform: PlatformCredentialService = platformCredentials
): Promise<SessionIntegration[]> {
  const entries: SessionIntegration[] = [];
  // #921 平台保管的那几家连没连,以平台为准:开会话前现问一次(问不到用上一次的答复)—— 别的设备连上 / 断开的,
  // 这条会话就跟上了。之后会话里那台的工具清单定死在模型前缀里,中途断开由转发口当场说「没连」。
  if (integrationPluginRegistry.getAll().some((plugin) => platform.isPlatformProvider(plugin.metadata.id))) {
    await platform.refresh({ maxAgeMs: 0 });
  }
  for (const plugin of integrationPluginRegistry.getAll()) {
    const integrationId = plugin.metadata.id;
    if (isMailIntegration(integrationId)) {
      if (!(await integrationCredentialStore.isConfigured(integrationId))) continue;
      entries.push({
        integrationId,
        upstream: {
          kind: 'local',
          tools: mailIntegrationTools(plugin.metadata.name, async () =>
            (await integrationCredentialStore.listAccounts(integrationId)).map((account) => account.credentials)
          ),
        },
      });
      continue;
    }
    if (platform.isPlatformProvider(integrationId)) {
      if (!(await platform.isConnected(integrationId))) continue;
      // 地址是平台的转发口、令牌是本人此刻的会话令牌,每次调用现取;凭据由平台挂上,❌ 在这台设备上。
      entries.push({ integrationId, upstream: { kind: 'remote', endpoint: (signal) => platform.mcpEndpoint(integrationId, signal) } });
      continue;
    }
    const serverUrl = mcpOAuthServerUrl(integrationId);
    if (!serverUrl) continue;
    if (!(await integrationCredentialStore.isConfigured(integrationId))) continue;
    entries.push({
      integrationId,
      upstream: {
        kind: 'remote',
        endpoint: async (signal) => {
          signal?.throwIfAborted();
          const account = await integrationConnectionService.getFreshAccount(integrationId);
          signal?.throwIfAborted();
          const parsed = mcpOAuthCredentialsSchema.safeParse(account?.credentials);
          if (!parsed.success) {
            // 断开连接 / 记录坏掉 ⇒ 让这一次调用**明确失败**,❌ 不返回空令牌让对方回 401 去猜。
            throw new Error(`${integrationId} is not connected in Gugu any more; reconnect it.`);
          }
          return { url: serverUrl, headers: { Authorization: `Bearer ${parsed.data.tokens.access_token}` } };
        },
      },
    });
  }
  return entries;
}
