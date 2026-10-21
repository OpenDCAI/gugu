import { err, ok } from '@gugu/session-shared';
import type { McpOAuthCredentials } from '../../../integrations/helpers/mcp-oauth';
import {
  callMcpToolJson,
  McpToolError,
  withMcpClient,
} from '../../../integrations/helpers/mcp-tool-client';
import type { ConnectedIntegrationHostContext } from '../../../integrations/host';
import { readNotionCredentials } from '../../../integrations/impl/notion/client';
import { toNotionIntegrationError } from '../../../integrations/impl/notion/error';
import {
  notionFetchResponseSchema,
  notionSearchResponseSchema,
  type NotionSearchResult,
} from '../../../integrations/impl/notion/types';
import { clampIssueLimit, normalizeSearchTerm } from '../../helpers/provider-inputs';
import { defineIssuesPlugin, registerIssuesPluginBehavior } from '../../plugin';
import type {
  IssueData,
  IssueGetOpts,
  IssueGetResult,
  IssueListResult,
  IssueSearchOpts,
} from '../../types';

/** notion-search returns at most 50 results per call. */
const NOTION_SEARCH_MAX_RESULTS = 50;

async function searchPages(credentials: McpOAuthCredentials, query: string): Promise<IssueData[]> {
  const raw = await withMcpClient(credentials, (client) =>
    callMcpToolJson(client, 'notion-search', { query })
  );
  const parsed = notionSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new McpToolError('notion-search', 'notion-search returned an unexpected response.');
  }
  return parsed.data.results
    .filter((result) => result.type === 'page' && result.title.trim())
    .map(toIssueData);
}

function toIssueData(result: NotionSearchResult): IssueData {
  return {
    identifier: result.id,
    displayIdentifier: null,
    title: result.title,
    url: result.url,
    ...(result.highlight ? { description: result.highlight } : {}),
    ...(result.timestamp ? { updatedAt: result.timestamp } : {}),
  };
}

export async function searchIssues(
  host: ConnectedIntegrationHostContext,
  opts: IssueSearchOpts
): Promise<IssueListResult> {
  const term = normalizeSearchTerm(opts.searchTerm);
  if (!term) return ok([]);

  const credentials = readNotionCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);

  const limit = clampIssueLimit(opts.limit, 20, NOTION_SEARCH_MAX_RESULTS);

  try {
    const pages = await searchPages(credentials.data, term);
    return ok(pages.slice(0, limit));
  } catch (error) {
    host.log.warn('Notion searchIssues failed', { error });
    return err(toNotionIntegrationError(error, 'Unable to search Notion pages.'));
  }
}

export async function getIssue(
  host: ConnectedIntegrationHostContext,
  opts: IssueGetOpts
): Promise<IssueGetResult> {
  const credentials = readNotionCredentials(host.credentials);
  if (!credentials.success) return err(credentials.error);

  try {
    const raw = await withMcpClient(credentials.data, (client) =>
      callMcpToolJson(client, 'notion-fetch', { id: opts.identifier })
    );
    const parsed = notionFetchResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new McpToolError('notion-fetch', 'notion-fetch returned an unexpected response.');
    }
    return ok({
      identifier: opts.identifier,
      displayIdentifier: null,
      title: parsed.data.title,
      url: parsed.data.url,
      // Already markdown with the page properties inlined — the agent-facing context as is.
      context: parsed.data.text,
    });
  } catch (error) {
    host.log.warn('Notion getIssue failed', { error });
    return err(toNotionIntegrationError(error, 'Unable to fetch Notion page context.'));
  }
}

const plugin = defineIssuesPlugin({ integrationId: 'notion' }, { issues: {} }, {});

export const provider = registerIssuesPluginBehavior(plugin, {
  issues: { searchIssues, getIssue },
});
