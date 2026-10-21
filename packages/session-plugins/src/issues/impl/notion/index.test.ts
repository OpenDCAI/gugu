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
    serverUrl: 'https://mcp.notion.com/mcp',
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

// Payload shapes as Notion MCP returns them: JSON inside the text content.
const searchPayload = {
  results: [
    {
      id: '30702dc5-9a3b-8106-b51b-ed6d1bfeeed4',
      title: 'Meeting Summary Report',
      url: 'https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4',
      type: 'page',
      highlight: 'Meeting materials',
      timestamp: '2026-02-15T00:07:00.000Z',
    },
    { id: 'db-1', title: 'Tasks', url: 'https://www.notion.so/db1', type: 'database' },
    { id: 'page-untitled', title: ' ', url: 'https://www.notion.so/untitled', type: 'page' },
  ],
  type: 'workspace_search',
};

const meetingIssue = {
  identifier: '30702dc5-9a3b-8106-b51b-ed6d1bfeeed4',
  displayIdentifier: null,
  title: 'Meeting Summary Report',
  url: 'https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4',
  description: 'Meeting materials',
  updatedAt: '2026-02-15T00:07:00.000Z',
};

afterEach(() => {
  mcp.callTool.mockReset();
});

describe('notion issues over MCP', () => {
  it('searches pages by term, leaving out databases and untitled pages', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText(searchPayload));

    const result = await searchIssues(host, { limit: 20, searchTerm: 'meeting' });

    expect(result).toEqual({ success: true, data: [meetingIssue] });
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'notion-search',
      arguments: { query: 'meeting' },
    });
  });

  it('honours the limit', async () => {
    const pages = Array.from({ length: 3 }, (_, index) => ({
      id: `page-${index}`,
      title: `Page ${index}`,
      url: `https://www.notion.so/page-${index}`,
      type: 'page',
    }));
    mcp.callTool.mockResolvedValueOnce(toolText({ results: pages }));

    const result = await searchIssues(host, { searchTerm: 'page', limit: 2 });

    expect(result.success && result.data.map((issue) => issue.identifier)).toEqual([
      'page-0',
      'page-1',
    ]);
    expect(mcp.callTool).toHaveBeenCalledWith({ name: 'notion-search', arguments: { query: 'page' } });
  });

  it('fetches a page as agent context', async () => {
    const text =
      '<page url="https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4">\n<content>\n# Project Overview\n</content>\n</page>';
    mcp.callTool.mockResolvedValueOnce(
      toolText({
        metadata: { type: 'page' },
        title: 'Project Overview',
        url: 'https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4',
        text,
      })
    );

    const result = await getIssue(host, { identifier: '30702dc5-9a3b-8106-b51b-ed6d1bfeeed4' });

    expect(result).toEqual({
      success: true,
      data: {
        identifier: '30702dc5-9a3b-8106-b51b-ed6d1bfeeed4',
        displayIdentifier: null,
        title: 'Project Overview',
        url: 'https://www.notion.so/30702dc59a3b8106b51bed6d1bfeeed4',
        context: text,
      },
    });
    expect(mcp.callTool).toHaveBeenCalledWith({
      name: 'notion-fetch',
      arguments: { id: '30702dc5-9a3b-8106-b51b-ed6d1bfeeed4' },
    });
  });

  it('reports a changed response shape instead of rendering an empty list', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText({ pages: [] }));

    const result = await searchIssues(host, { limit: 20, searchTerm: 'meeting' });

    expect(result).toEqual({
      success: false,
      error: { type: 'generic', message: 'notion-search returned an unexpected response.' },
    });
  });

  it('passes a tool error through with its own message', async () => {
    mcp.callTool.mockResolvedValueOnce(toolText('Could not find page with ID: nope', true));

    const result = await getIssue(host, { identifier: 'nope' });

    expect(result).toEqual({
      success: false,
      error: { type: 'generic', message: 'Could not find page with ID: nope' },
    });
  });

  it('asks a token-era record to reconnect without calling Notion', async () => {
    const result = await searchIssues(
      { log: logger, credentials: { apiToken: 'ntn_old' } },
      { limit: 20, searchTerm: 'meeting' }
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'auth_failed',
        message:
          'Notion now connects through browser authorization. Disconnect Notion and connect it again.',
      },
    });
    expect(mcp.callTool).not.toHaveBeenCalled();
  });
});
