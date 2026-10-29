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

/**
 * 高德说「这把 key 本身不对」的码。只有这几个算坏 key(auth_failed);码表照高德官方「错误码说明」
 * https://lbs.amap.com/api/webservice/guide/tools/info(页面标 2022-10-12 更新):
 *   10001 INVALID_USER_KEY      key不正确或过期
 *   10009 USERKEY_PLAT_NOMATCH  请求key与绑定平台不符
 *   10013 USER_KEY_RECYCLED     Key被删除
 * 其余(访问量 / QPS / 余额、白名单 / 签名、服务权限、账号被封、服务器忙、参数问题、表里没有的新码)都不是 key 坏了:
 * 当「这会儿用不了」(host_unreachable),❌ 说 key 被拒、❌ 让好 key 显示成要重新授权。拿不准就不算。
 * 与平台那边(gugu-cloud `services/cloud-computer/src/integrations/mcp-wire.ts`)同一条规则。
 */
const AMAP_KEY_INVALID: ReadonlyMap<string, string> = new Map([
  ['10001', 'INVALID_USER_KEY'],
  ['10009', 'USERKEY_PLAT_NOMATCH'],
  ['10013', 'USER_KEY_RECYCLED'],
]);
const AMAP_KEY_INVALID_INFO: ReadonlySet<string> = new Set(AMAP_KEY_INVALID.values());

export type KeyRefusal = {
  /** 高德的 info(没有就是 infocode),给报错用。 */
  info: string;
  /** 明说 key 本身不对:info / infocode 里给了的都指向同一个上面那几个码。 */
  keyInvalid: boolean;
};

/** 高德那种「HTTP 200 + {status:'0', info, infocode}」的拒绝;不是这种回法 = null。info 和 infocode 都给了却说的不是同一件事 → 不算 key 不对。 */
export function amapRefusal(body: unknown): KeyRefusal | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as { status?: unknown; info?: unknown; infocode?: unknown };
  const code = typeof b.infocode === 'string' || typeof b.infocode === 'number' ? String(b.infocode) : null;
  const info = typeof b.info === 'string' ? b.info : null;
  if (b.status !== '0' || (info === null && code === null)) return null;
  const said = [code === null ? null : (AMAP_KEY_INVALID.get(code) ?? ''), info === null ? null : AMAP_KEY_INVALID_INFO.has(info) ? info : '']
    .filter((name): name is string => name !== null);
  return { info: info ?? `infocode ${code}`, keyInvalid: said.every((name) => name !== '' && name === said[0]) };
}

/** 工具调用 isError 的那段字是不是在说「key 本身不对」:字里大写下划线写法的码只有一个、且是上面那几个之一。 */
export function amapKeyInvalidText(text: string): boolean {
  const names = new Set(text.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/g) ?? []);
  return names.size === 1 && AMAP_KEY_INVALID_INFO.has([...names][0]!);
}

/** 高德这类服务对坏 key 不回 HTTP 错误,而是回 200 + `{status:"0",info,infocode}`:先认出它,❌ 让 MCP 客户端报一句看不懂的解析错。 */
export async function readKeyRejection(url: string, fetchImpl: typeof fetch = fetch): Promise<KeyRefusal | null> {
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
  return amapRefusal(await response.json().catch(() => null));
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
  const key = String(credentials[mcp.keyField]).trim();
  const masked = (text: string) => text.split(key).join('***');
  try {
    const refusal = await readKeyRejection(url, fetchImpl);
    if (refusal) {
      return { connected: false, error: refusal.keyInvalid ? keyRejected(name, masked(refusal.info)) : notServing(name, masked(refusal.info)) };
    }
    const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl });
    const client = new Client({ name: 'gugu', version: '1.0.0' });
    await client.connect(transport);
    try {
      const tools = await listMcpToolNames(client);
      if (tools.length === 0) return { connected: false, error: { type: 'generic', message: `${name} MCP exposes no tools.` } };
      if (mcp.probe) {
        // 列得出工具不代表 key 能用(高德对任何格式对的 key 都列工具),真调一次只读的才算数。
        if (!tools.includes(mcp.probe.tool)) {
          return { connected: false, error: { type: 'generic', message: `${name} MCP no longer offers ${mcp.probe.tool}; Gugu cannot check the key.` } };
        }
        const result = await client.callTool({ name: mcp.probe.tool, arguments: mcp.probe.arguments });
        if (result.isError) {
          const content: unknown[] = Array.isArray(result.content) ? result.content : [];
          const text = content.map((part) => (part as { text?: unknown }).text).filter((t) => typeof t === 'string').join(' ');
          const said = masked(text || 'unknown error');
          return { connected: false, error: amapKeyInvalidText(text) ? keyRejected(name, said) : notServing(name, said) };
        }
      }
    } finally {
      await client.close();
    }
    return { connected: true, credentials: { ...credentials, [mcp.keyField]: String(credentials[mcp.keyField]).trim() } };
  } catch (error) {
    // 报错里可能带着请求地址 —— 地址里就是 key。
    const message = masked((error as Error).message ?? String(error));
    return { connected: false, error: { type: 'host_unreachable', message: `${name} could not be reached: ${message}` } };
  }
}

function keyRejected(name: string, said: string): { type: 'auth_failed'; message: string } {
  return { type: 'auth_failed', message: `${name} rejected the key (${said}). Check the key and that its service type is Web 服务.` };
}

/** 不是 key 坏了(额度、QPS、白名单、服务器忙……):这会儿用不了,稍后再试。 */
function notServing(name: string, said: string): { type: 'host_unreachable'; message: string } {
  return { type: 'host_unreachable', message: `${name} is not serving this key right now (${said}); try again later.` };
}
