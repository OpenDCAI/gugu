import type { Logger } from '@gugu/session-shared/logger';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationHostContext } from '../../host';
import { provider } from './index';

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  sessions: [] as unknown[],
}));

// Only the network session is faked; tool listing and error mapping stay real.
vi.mock('../../helpers/mcp-tool-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../helpers/mcp-tool-client')>();
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

const auth = provider.behavior.auth;
if (!auth) throw new Error('Linear auth behavior is not registered.');

const host: IntegrationHostContext = { log: logger };

const credentials = {
  serverUrl: 'https://mcp.linear.app/mcp/readonly',
  redirectUrl: 'http://127.0.0.1:53682/callback',
  clientInformation: { client_id: 'client-1' },
  tokens: {
    access_token: 'access-1',
    token_type: 'bearer',
    refresh_token: 'refresh-1',
    expires_in: 3600,
  },
  obtainedAt: 1_000,
};

function tools(...names: string[]) {
  return { tools: names.map((name) => ({ name, inputSchema: { type: 'object' } })) };
}

afterEach(() => {
  mcp.listTools.mockReset();
  mcp.sessions.length = 0;
});

describe('linear integration auth', () => {
  it('authorizes in the browser through the read-only hosted MCP, never an API key', () => {
    expect(provider.capabilities.auth.methods).toEqual([
      { kind: 'mcp-oauth', serverUrl: 'https://mcp.linear.app/mcp/readonly' },
    ]);
  });

  it('verifies the stored authorization against the MCP tools the issue picker needs', async () => {
    mcp.listTools.mockResolvedValueOnce(tools('list_issues', 'get_issue', 'list_teams'));

    const result = await auth.verify(host, credentials);

    expect(result).toEqual({ connected: true });
    expect(mcp.sessions).toEqual([credentials]);
  });

  it('asks an API-key-era record to reconnect instead of opening a session with it', async () => {
    const result = await auth.verify(host, { apiKey: 'lin_api_old' });

    expect(result).toEqual({
      connected: false,
      error: expect.objectContaining({
        message: 'Linear now connects through browser authorization. Disconnect Linear and connect it again.',
      }),
    });
    expect(mcp.sessions).toEqual([]);
  });

  it('names the tools the server actually offers when one the picker calls is missing', async () => {
    mcp.listTools.mockResolvedValueOnce(tools('list_issues', 'list_teams'));

    const result = await auth.verify(host, credentials);

    expect(result).toEqual({
      connected: false,
      error: expect.objectContaining({ message: 'Linear MCP does not expose get_issue. It offers: list_issues, list_teams.' }),
    });
  });

  it('maps a rejected access token to a reconnect message', async () => {
    mcp.listTools.mockRejectedValueOnce(new StreamableHTTPError(401, 'Unauthorized'));

    const result = await auth.verify(host, credentials);

    expect(result).toEqual({
      connected: false,
      error: expect.objectContaining({ message: 'Linear authorization expired or was revoked. Reconnect Linear.' }),
    });
  });
});
