import type { Logger } from '@gugu/session-shared/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { getIssue, searchIssues } from './index';

const mcp = vi.hoisted(() => ({ callTool: vi.fn() }));

// Only the network session is faked; JSON extraction, schema checks and mapping stay real.
vi.mock('../../../integrations/helpers/mcp-tool-client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../integrations/helpers/mcp-tool-client')>();
  return {
    ...actual,
    withMcpClient: async (_credentials: unknown, run: (client: unknown) => Promise<unknown>) =>
      run({ callTool: mcp.callTool }),
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

const host: ConnectedIntegrationHostContext = {
  log: logger,
  credentials: {
    serverUrl: 'https://mcp.linear.app/mcp/readonly',
    redirectUrl: 'http://127.0.0.1:53682/callback',
    clientInformation: { client_id: 'client-1' },
    tokens: { access_token: 'access-1', token_type: 'bearer' },
    obtainedAt: 1_000,
  },
};

function toolText(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    isError,
  };
}

const issue = {
  id: '5b3f0e2a-2f4f-4a1a-9a6d-9e0b7b2c1d33',
  identifier: 'LIN-123',
  title: 'Composer drops the first keystroke',
  url: 'https://linear.app/gugu/issue/LIN-123',
  description: 'Typing immediately after focus loses one character.',
  branchName: 'lin-123-composer-drops-keystroke',
  updatedAt: '2026-09-14T10:00:00.000Z',
  state: { name: 'In Progress' },
  project: { name: 'Task page' },
  assignee: { name: 'example', displayName: 'Example Person' },
};

afterEach(() => mcp.callTool.mockReset());

describe('linear issues over the hosted MCP', () => {
  it('maps a found issue onto the picker shape', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText({ issues: [issue] }));

    const result = await searchIssues(host, { searchTerm: 'composer', limit: 50 });

    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'list_issues',
      arguments: { query: 'composer', limit: 50 },
    });
    expect(result).toEqual({
      success: true,
      data: [
        {
          identifier: 'LIN-123',
          title: 'Composer drops the first keystroke',
          url: 'https://linear.app/gugu/issue/LIN-123',
          description: 'Typing immediately after focus loses one character.',
          branchName: 'lin-123-composer-drops-keystroke',
          status: 'In Progress',
          assignees: ['Example Person'],
          project: 'Task page',
          updatedAt: '2026-09-14T10:00:00.000Z',
        },
      ],
    });
  });

  it('accepts a bare array as well as a wrapped list', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText([{ title: 'Bare', identifier: 'LIN-1' }]));

    const result = await searchIssues(host, { searchTerm: 'composer', limit: 50 });

    expect(result).toEqual({ success: true, data: [{ identifier: 'LIN-1', title: 'Bare' }] });
  });

  it('searches through list_issues, which is where the official server takes a query', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText({ issues: [] }));

    await searchIssues(host, { searchTerm: '  composer  ', limit: 20 });

    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'list_issues',
      arguments: { query: 'composer', limit: 20 },
    });
  });

  it('never calls the server for an empty search term', async () => {
    const result = await searchIssues(host, { searchTerm: '   ', limit: 20 });

    expect(result).toEqual({ success: true, data: [] });
    expect(mcp.callTool).not.toHaveBeenCalled();
  });

  it('reads one issue by identifier', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText(issue));

    const result = await getIssue(host, { identifier: 'LIN-123' });

    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'get_issue',
      arguments: { id: 'LIN-123' },
    });
    expect(result.success && result.data.identifier).toBe('LIN-123');
  });

  it('surfaces an unrecognized response instead of reporting an empty workspace', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText({ unexpected: true }));

    const result = await searchIssues(host, { searchTerm: 'composer', limit: 50 });

    expect(result).toEqual({
      success: false,
      error: { type: 'generic', message: 'list_issues returned an unexpected response.' },
    });
  });

  it('asks an API-key-era record to reconnect', async () => {
    const result = await searchIssues(
      { ...host, credentials: { apiKey: 'lin_api_old' } },
      { searchTerm: 'composer', limit: 50 }
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'auth_failed',
        message:
          'Linear now connects through browser authorization. Disconnect Linear and connect it again.',
      },
    });
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});
