import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IntegrationKeyedMcp, VerifyResult } from '../capabilities/auth';
import type { IntegrationCredentials } from '../host';
import { listMcpToolNames } from './mcp-tool-client';

/**
 * 用户自己的 key 拼进地址的托管 MCP(高德:`?key=`)。和 `hosted-mcp.ts` 同一立场:咕咕不调它的工具,
 * 「连得上」只看用这把 key 能不能列出工具。地址每次现拼,❌ 把带 key 的地址存下来或打进日志。
 */
export function keyedMcpUrl(mcp: IntegrationKeyedMcp, credentials: IntegrationCredentials): string {
  const key = credentials[mcp.keyField];
  if (typeof key !== 'string' || !key.trim()) throw new Error(`Missing ${mcp.keyField}; connect again with a key.`);
  const url = new URL(mcp.serverUrl);
  url.searchParams.set(mcp.keyQueryParam, key.trim());
  return url.toString();
}

/** 高德这类服务对坏 key 不回 HTTP 错误,而是回 200 + `{status:"0",info:"INVALID_USER_KEY"}`:先认出它,❌ 让 MCP 客户端报一句看不懂的解析错。 */
export async function readKeyRejection(url: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'gugu', version: '1.0.0' } },
    }),
  });
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return null;
  const body = (await response.json().catch(() => null)) as { status?: unknown; info?: unknown } | null;
  return body && body.status === '0' && typeof body.info === 'string' ? body.info : null;
}

export async function verifyKeyedMcpCredentials(
  name: string,
  mcp: IntegrationKeyedMcp,
  credentials: IntegrationCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<VerifyResult> {
  let url: string;
  try {
    url = keyedMcpUrl(mcp, credentials);
  } catch (error) {
    return { connected: false, error: { type: 'auth_failed', message: (error as Error).message } };
  }
  try {
    const rejection = await readKeyRejection(url, fetchImpl);
    if (rejection) {
      return { connected: false, error: { type: 'auth_failed', message: `${name} rejected the key (${rejection}). Check the key and that its service type is Web 服务.` } };
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl });
    const client = new Client({ name: 'gugu', version: '1.0.0' });
    await client.connect(transport);
    try {
      const tools = await listMcpToolNames(client);
      if (tools.length === 0) return { connected: false, error: { type: 'generic', message: `${name} MCP exposes no tools.` } };
    } finally {
      await client.close();
    }
    return { connected: true, credentials: { ...credentials, [mcp.keyField]: String(credentials[mcp.keyField]).trim() } };
  } catch (error) {
    const key = String(credentials[mcp.keyField]).trim();
    // 报错里可能带着请求地址 —— 地址里就是 key。
    const message = ((error as Error).message ?? String(error)).split(key).join('***');
    return { connected: false, error: { type: 'host_unreachable', message: `${name} could not be reached: ${message}` } };
  }
}
