import { err, ok, type Result } from '@gugu/session-shared';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { VerifyResult } from '../capabilities/auth';
import type { IntegrationCredentials } from '../host';
import type { IntegrationError } from '../types';
import { readMcpOAuthCredentials } from './mcp-oauth';
import { listMcpToolNames, withMcpClient } from './mcp-tool-client';

/**
 * 只当「给 agent 用的服务」的托管 MCP(飞书、腾讯文档、滴答清单):咕咕自己不调它的任何工具,
 * agent 拿到的是那一家原样给的整套工具。所以「连得上」的判据只有一条 —— 用存下的令牌能列出工具。
 * ❌ 在这里钉具体工具名:那是别人家会改的东西,钉了只会让一次改名变成「连不上」。
 */
export async function verifyHostedMcpCredentials(
  name: string,
  rawCredentials: IntegrationCredentials
): Promise<VerifyResult> {
  const result = await listHostedMcpTools(name, rawCredentials);
  if (!result.success) return { connected: false, error: result.error };
  return { connected: true };
}

async function listHostedMcpTools(
  name: string,
  rawCredentials: IntegrationCredentials
): Promise<Result<string[], IntegrationError>> {
  const credentials = readMcpOAuthCredentials(
    rawCredentials,
    `${name} connects through browser authorization. Disconnect ${name} and connect it again.`
  );
  if (!credentials.success) return err(credentials.error);

  try {
    const tools = await withMcpClient(credentials.data, listMcpToolNames);
    if (tools.length === 0) {
      return err({ type: 'generic', message: `${name} MCP exposes no tools.` });
    }
    return ok(tools);
  } catch (error) {
    return err(toHostedMcpIntegrationError(name, error));
  }
}

export function toHostedMcpIntegrationError(name: string, error: unknown): IntegrationError {
  if (error instanceof StreamableHTTPError && typeof error.code === 'number') {
    // A browser-authorized token the server turns away: it ran out or was revoked.
    if (error.code === 401) {
      return {
        type: 'authorization_expired',
        message: `${name} authorization expired or was revoked. Reconnect ${name}.`,
      };
    }
    if (error.code === 403) {
      return {
        type: 'auth_failed',
        message: `${name} did not grant the permissions its MCP tools need. Reconnect ${name}.`,
      };
    }
    if (error.code === 429) {
      return { type: 'rate_limited', message: `${name} rate limit exceeded. Please try again shortly.` };
    }
    if (error.code >= 500) {
      return { type: 'host_unreachable', message: `${name} is temporarily unavailable. Please try again.` };
    }
  }
  if (error instanceof Error && error.message) return { type: 'generic', message: error.message };
  return { type: 'generic', message: `Failed to verify ${name} authorization.` };
}
