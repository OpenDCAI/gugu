import { describe, expect, it } from 'vitest';
import { AMAP_KEY_GUIDE_URL, AMAP_MCP_URL } from '../impl/amap';
import { integrationPluginRegistry } from '../registry';
import { keyedMcpUrl, verifyKeyedMcpCredentials } from './keyed-mcp';

const GOOD = '0123456789abcdef0123456789abcdef';
const mcp = {
  serverUrl: AMAP_MCP_URL,
  keyField: 'apiKey',
  keyQueryParam: 'key',
  probe: { tool: 'maps_weather', arguments: { city: '北京' } },
};

/**
 * 只假网络,照高德真实的样子回(2026-10-28 实测):格式不对的 key 回 200 + 高德自己的错误体;
 * 格式对但无效的 key 照样能 initialize、列工具,真调用才回 isError「INVALID_USER_KEY」。
 */
function fakeAmap(validKey: string) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url.toString());
    if ((init?.method ?? 'GET') !== 'POST') return new Response(null, { status: 405 });
    const key = url.searchParams.get('key') ?? '';
    if (!/^[0-9a-f]{32}$/.test(key)) {
      return Response.json({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' });
    }
    const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'amap', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: ['maps_direction_driving', 'maps_weather'].map((name) => ({ name, inputSchema: { type: 'object' } })) }
          : key === validKey
            ? { content: [{ type: 'text', text: '{"city":"北京市"}' }] }
            : { content: [{ type: 'text', text: 'API 调用失败：INVALID_USER_KEY' }], isError: true };
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
    const amap = fakeAmap(GOOD);
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: ` ${GOOD} ` }, amap.fetchImpl);
    expect(result).toEqual({ connected: true, credentials: { apiKey: GOOD } });
    expect(amap.urls.every((url) => url === `https://mcp.amap.com/mcp?key=${GOOD}`)).toBe(true);
  });

  it.each([
    ['a malformed key, rejected on initialize', 'secret-bad-key'],
    ['a well-formed wrong key, rejected only on a real call', 'f'.repeat(32)],
  ])('names the vendor rejection for %s and never echoes the key', async (_case, key) => {
    const amap = fakeAmap(GOOD);
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: key }, amap.fetchImpl);
    expect(result.connected).toBe(false);
    if (result.connected) return;
    expect(result.error?.type).toBe('auth_failed');
    expect(result.error?.message).toContain('INVALID_USER_KEY');
    expect(result.error?.message).not.toContain(key);
  });

  it('fails loudly when the probe tool disappears instead of connecting an unchecked key', async () => {
    const amap = fakeAmap(GOOD);
    const result = await verifyKeyedMcpCredentials(
      '高德地图', { ...mcp, probe: { tool: 'maps_gone', arguments: {} } }, { apiKey: GOOD }, amap.fetchImpl
    );
    expect(result.connected).toBe(false);
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
