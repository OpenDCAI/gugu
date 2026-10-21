import type { Logger } from '@gugu/session-shared/logger';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationHostContext } from '../host';
import { provider as dida } from '../impl/dida';
import { provider as tencentDocs } from '../impl/tencent-docs';
import { integrationPluginRegistry } from '../registry';

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  sessions: [] as unknown[],
}));

// Only the network session is faked; tool listing and error mapping stay real.
vi.mock('./mcp-tool-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mcp-tool-client')>();
  return {
    ...actual,
    withMcpClient: async (credentials: unknown, run: (client: unknown) => Promise<unknown>) => {
      mcp.sessions.push(credentials);
      return run({ listTools: mcp.listTools });
    },
  };
});

const logger: Logger = {
  level: 'error',
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};
const host: IntegrationHostContext = { log: logger };

function stored(serverUrl: string) {
  return {
    serverUrl,
    redirectUrl: 'http://127.0.0.1:53682/callback',
    clientInformation: { client_id: 'client-1' },
    tokens: { access_token: 'access-1', token_type: 'bearer', expires_in: 3600 },
    obtainedAt: 1_000,
  };
}

function tools(...names: string[]) {
  return { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
}

afterEach(() => {
  mcp.listTools.mockReset();
  mcp.sessions.length = 0;
});

// 国产平台的官方云端 MCP(#7210):只给 agent 用,咕咕自己不调它们的任何工具。
const cases = [
  { provider: tencentDocs, id: 'tencent-docs', name: '腾讯文档', serverUrl: 'https://docs.qq.com/openapi/mcp' },
  { provider: dida, id: 'dida', name: '滴答清单', serverUrl: 'https://mcp.dida365.com' },
] as const;

describe.each(cases)('$name 的集成', ({ provider, id, name, serverUrl }) => {
  const auth = provider.behavior.auth;
  if (!auth) throw new Error(`${id} auth behavior is not registered.`);

  it('在注册表里,经官方托管 MCP 在浏览器里授权(❌ 填 key)', () => {
    expect(integrationPluginRegistry.get(id)).toBe(provider);
    expect(provider.metadata.name).toBe(name);
    expect(provider.capabilities.auth.methods).toEqual([{ kind: 'mcp-oauth', serverUrl }]);
  });

  it('用存下的令牌能列出工具 = 连上了', async () => {
    mcp.listTools.mockResolvedValueOnce(tools('anything'));

    await expect(auth.verify(host, stored(serverUrl))).resolves.toEqual({ connected: true });
    expect(mcp.sessions).toEqual([stored(serverUrl)]);
  });

  it('一个工具都不给 ⇒ 没连上,❌ 当成连着(agent 拿到的会是一台空 server)', async () => {
    mcp.listTools.mockResolvedValueOnce(tools());

    const result = await auth.verify(host, stored(serverUrl));

    expect(result).toEqual({
      connected: false,
      error: { type: 'generic', message: `${name} MCP exposes no tools.` },
    });
  });

  it('令牌被拒(过期 / 撤销)⇒ 授权已失效,要重新连接', async () => {
    mcp.listTools.mockRejectedValueOnce(new StreamableHTTPError(401, 'Unauthorized'));

    const result = await auth.verify(host, stored(serverUrl));

    expect(result).toEqual({
      connected: false,
      error: expect.objectContaining({ type: 'authorization_expired' }),
    });
  });

  it('存着的不是一份浏览器授权 ⇒ 让人重新连,❌ 拿它开会话', async () => {
    const result = await auth.verify(host, { apiToken: 'pasted' });

    expect(result).toEqual({
      connected: false,
      error: expect.objectContaining({ type: 'auth_failed' }),
    });
    expect(mcp.sessions).toEqual([]);
  });
});
