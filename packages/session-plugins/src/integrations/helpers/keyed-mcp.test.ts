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
function fakeAmap(validKey: string, answer: { refusal?: Record<string, unknown>; callError?: string } = {}) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    urls.push(url.toString());
    if ((init?.method ?? 'GET') !== 'POST') return new Response(null, { status: 405 });
    const key = url.searchParams.get('key') ?? '';
    // AMap's own refusal shape, on every step (what it answers for a missing or malformed key, or a refused account).
    if (answer.refusal) return Response.json(answer.refusal);
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
          : answer.callError
            ? { content: [{ type: 'text', text: answer.callError }], isError: true }
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

  /**
   * #921 Only AMap's key-invalid codes mean the key itself is wrong (https://lbs.amap.com/api/webservice/guide/tools/info,
   * 2022-10-12): 10001 INVALID_USER_KEY, 10009 USERKEY_PLAT_NOMATCH, 10013 USER_KEY_RECYCLED. Anything else (quota, QPS,
   * whitelist, permission, server errors, unknown codes) is AMap not serving right now: try again later, never "rejected".
   * Same rule as the platform's matcher (gugu-cloud `mcp-wire.ts`).
   */
  it.each([
    ['10001 INVALID_USER_KEY', { status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }, 'auth_failed'],
    ['10009 USERKEY_PLAT_NOMATCH', { status: '0', info: 'USERKEY_PLAT_NOMATCH', infocode: '10009' }, 'auth_failed'],
    ['10013 USER_KEY_RECYCLED', { status: '0', info: 'USER_KEY_RECYCLED', infocode: '10013' }, 'auth_failed'],
    ['a key-invalid info alone', { status: '0', info: 'USER_KEY_RECYCLED' }, 'auth_failed'],
    ['a key-invalid infocode alone', { status: '0', infocode: '10009' }, 'auth_failed'],
    ['the daily quota (10003)', { status: '0', info: 'DAILY_QUERY_OVER_LIMIT', infocode: '10003' }, 'provider_unavailable'],
    ['a whitelist refusal (10005)', { status: '0', info: 'INVALID_USER_IP', infocode: '10005' }, 'provider_unavailable'],
    ['info and infocode that disagree', { status: '0', info: 'INVALID_USER_KEY', infocode: '10003' }, 'provider_unavailable'],
    ['an unknown code', { status: '0', info: 'SOMETHING_NEW', infocode: '19999' }, 'provider_unavailable'],
  ] as const)('AMap’s top-level refusal with %s: a wrong key only for the three key-invalid codes', async (_case, refusal, type) => {
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: GOOD }, fakeAmap(GOOD, { refusal }).fetchImpl);
    expect(result.connected).toBe(false);
    if (result.connected) return;
    expect(result.error?.type).toBe(type);
    expect(result.error?.message).not.toContain(GOOD);
  });

  it.each([
    ['INVALID_USER_KEY', 'API 调用失败：INVALID_USER_KEY', 'auth_failed'],
    ['USERKEY_PLAT_NOMATCH', 'API 调用失败：USERKEY_PLAT_NOMATCH', 'auth_failed'],
    ['USER_KEY_RECYCLED', 'API 调用失败：USER_KEY_RECYCLED', 'auth_failed'],
    ['the daily quota', `API 调用失败：DAILY_QUERY_OVER_LIMIT (key ${GOOD})`, 'provider_unavailable'],
    ['QPS', 'API 调用失败：CUQPS_HAS_EXCEEDED_THE_LIMIT', 'provider_unavailable'],
    ['two codes at once', 'API 调用失败：INVALID_USER_KEY, CUQPS_HAS_EXCEEDED_THE_LIMIT', 'provider_unavailable'],
    ['no code at all', 'API 调用失败：服务器繁忙', 'provider_unavailable'],
  ] as const)('a tool call that fails with %s: a wrong key only for exactly one key-invalid code', async (_case, callError, type) => {
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: GOOD }, fakeAmap(GOOD, { callError }).fetchImpl);
    expect(result.connected).toBe(false);
    if (result.connected) return;
    expect(result.error?.type).toBe(type);
    expect(result.error?.message).not.toContain(GOOD);
  });

  it('a tool result that is not an error is not a wrong key, even when its text says INVALID_USER_KEY', async () => {
    const amap = fakeAmap(GOOD);
    const said = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
      if (message.method === 'tools/call') {
        return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '{"info":"INVALID_USER_KEY"}' }] } });
      }
      return amap.fetchImpl(input, init);
    }) as typeof fetch;
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: GOOD }, said);
    expect(result).toEqual({ connected: true, credentials: { apiKey: GOOD } });
  });

  it('a network failure stays “can’t reach AMap”: only an answer from AMap is “not available right now”', async () => {
    const down = (async () => {
      throw new TypeError(`fetch failed for https://mcp.amap.com/mcp?key=${GOOD}`);
    }) as unknown as typeof fetch;
    const result = await verifyKeyedMcpCredentials('高德地图', mcp, { apiKey: GOOD }, down);
    expect(result.connected).toBe(false);
    if (result.connected) return;
    expect(result.error?.type).toBe('host_unreachable');
    expect(result.error?.message).not.toContain(GOOD);
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
