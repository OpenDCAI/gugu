import { describe, expect, it } from 'vitest';
import { AMAP_KEY_GUIDE_URL, AMAP_MCP_URL } from '../impl/amap';
import { integrationPluginRegistry } from '../registry';
import { keyedMcpUrl, verifyKeyedMcpCredentials } from './keyed-mcp';

const mcp = { serverUrl: AMAP_MCP_URL, keyField: 'apiKey', keyQueryParam: 'key' };

/** 只假网络:一台按 JSON 回话的 MCP(高德就是这么回的),坏 key 回 200 + 高德自己的错误体。 */
function fakeAmap(validKey: string) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url.toString());
    if ((init?.method ?? 'GET') !== 'POST') return new Response(null, { status: 405 });
    if (url.searchParams.get('key') !== validKey) {
      return Response.json({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' });
    }
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'amap', version: '1' } }
        : { tools: [{ name: 'maps_direction_driving', inputSchema: { type: 'object' } }] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('keyed hosted MCP (AMap)', () => {
  it('puts the trimmed key in the vendor query parameter', () => {
    expect(keyedMcpUrl(mcp, { apiKey: '  abc  ' })).toBe('https://mcp.amap.com/mcp?key=abc');
  });

  it('fails loudly instead of building an address without a key', () => {
    expect(() => keyedMcpUrl(mcp, {})).toThrow(/apiKey/);
    expect(() => keyedMcpUrl(mcp, { apiKey: ' ' })).toThrow(/apiKey/);
  });

  it('connects when the key lists tools, and stores the trimmed key', async () => {
    const amap = fakeAmap('good-key');
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: ' good-key ' }, amap.fetchImpl);
    expect(result).toEqual({ connected: true, credentials: { apiKey: 'good-key' } });
    expect(amap.urls.every((url) => url === 'https://mcp.amap.com/mcp?key=good-key')).toBe(true);
  });

  it('names the vendor rejection for a bad key and never echoes the key', async () => {
    const amap = fakeAmap('good-key');
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: 'secret-bad-key' }, amap.fetchImpl);
    expect(result.connected).toBe(false);
    if (result.connected) return;
    expect(result.error?.type).toBe('auth_failed');
    expect(result.error?.message).toContain('INVALID_USER_KEY');
    expect(result.error?.message).not.toContain('secret-bad-key');
  });

  it('registers AMap as a key form that points people at the free key guide', () => {
    const methods = integrationPluginRegistry.get('amap')?.capabilities.auth.methods ?? [];
    expect(methods).toHaveLength(1);
    const [method] = methods;
    expect(method?.kind).toBe('form');
    if (method?.kind !== 'form') return;
    expect(method.mcp).toEqual(mcp);
    expect(method.helpUrl).toBe(AMAP_KEY_GUIDE_URL);
    expect(method.fields.map((field) => [field.id, field.secret])).toEqual([['apiKey', true]]);
  });
});
