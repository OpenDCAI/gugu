import {
  integrationPluginRegistry,
  keyedMcpUrl,
  mcpOAuthCredentialsSchema,
  type IntegrationKeyedMcp,
} from '@gugu/session-plugins/integrations';
import type { IntegrationUpstream } from '../../../../integration-mcp-bridge';
import { integrationCredentialStore } from './integration-credential-store-instance';
import { integrationConnectionService } from './integration-connection-service';
import { isMailIntegration, mailIntegrationTools } from './mail/mail-tools';
import type { PlatformCredentialService } from './platform-credentials';
import { platformCredentials } from './platform-credentials-instance';

/**
 * 一家已连接、能以 MCP 工具交给 agent 的集成 —— 会话里给 agent 的就是这些。
 * 托管 MCP 那几家转发给对方(`remote`);凭据由平台保管的(高德,#921)转发给平台的转发口(也是 `remote`),
 * 只有没有这项平台服务的安装上才由这台电脑带着本机存的 key 直连对方;邮箱由咕咕自己答(`local`,#7240)。
 */
export type SessionIntegration = {
  integrationId: string;
  upstream: IntegrationUpstream;
};

/** 用户自己的 key 拼进地址的托管 MCP(高德):只在没有平台服务、key 存在这台电脑上时用。 */
function keyedMcp(integrationId: string): IntegrationKeyedMcp | null {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  for (const method of methods) if (method.kind === 'form' && method.mcp) return method.mcp;
  return null;
}

function mcpOAuthServerUrl(integrationId: string): string | null {
  const methods = integrationPluginRegistry.get(integrationId)?.capabilities.auth.methods ?? [];
  const method = methods.find((candidate) => candidate.kind === 'mcp-oauth');
  return method?.kind === 'mcp-oauth' ? method.serverUrl : null;
}

/**
 * Whether a connected integration hands an agent anything to call in a session: mail tools, a hosted MCP, or (#921)
 * the platform forwarder's MCP for a credential the platform keeps — with or without a local fallback address.
 */
export function integrationGivesSessionTools(integrationId: string): boolean {
  return (
    isMailIntegration(integrationId) ||
    platformCredentials.isPlatformProvider(integrationId) ||
    keyedMcp(integrationId) !== null ||
    mcpOAuthServerUrl(integrationId) !== null
  );
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
  // #921 平台保管的那几家:按这台设备上已照抄下来的平台答复给,❌ 开会话等网络。平台在后台问(开 App、换登录、
  // 资源库 / 面板来看、这里顺手一次)。代价:别处刚断开的,这条会话可能还拿着工具(一调转发口就说「没连」,请他重连);
  // 别处刚连上的,下一条会话才有。
  if (integrationPluginRegistry.getAll().some((plugin) => platform.isPlatformProvider(plugin.metadata.id))) {
    void platform.refresh();
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
    if (platform.custody(integrationId) === 'platform') {
      if (!(await platform.isConnected(integrationId))) continue;
      // 地址是平台的转发口、令牌是本人此刻的会话令牌,每次调用现取;凭据由平台挂上,❌ 在这台设备上。
      entries.push({ integrationId, upstream: { kind: 'remote', endpoint: (signal) => platform.mcpEndpoint(integrationId, signal) } });
      continue;
    }
    const keyed = keyedMcp(integrationId);
    if (keyed) {
      // 走到这里只有一种情况:这个安装没有平台服务,key 存在这台电脑上(#649 的老路)。
      if (!(await integrationCredentialStore.isConfigured(integrationId))) continue;
      entries.push({
        integrationId,
        upstream: {
          kind: 'remote',
          endpoint: async (signal) => {
            signal?.throwIfAborted();
            const account = await integrationConnectionService.getFreshAccount(integrationId);
            signal?.throwIfAborted();
            // 断开连接 / key 没了 ⇒ keyedMcpUrl 明确抛错,❌ 拼一个不带 key 的地址让对方去猜。
            if (!account) throw new Error(`${integrationId} is not connected in Gugu any more; reconnect it.`);
            return { url: keyedMcpUrl(keyed, account.credentials), headers: {} };
          },
        },
      });
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
