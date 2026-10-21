import { err, ok, type Result } from '@gugu/session-shared';
import { readMcpOAuthCredentials, type McpOAuthCredentials } from '../../helpers/mcp-oauth';
import { listMcpToolNames, withMcpClient } from '../../helpers/mcp-tool-client';
import type { IntegrationCredentials } from '../../host';
import type { IntegrationError } from '../../types';
import { toNotionIntegrationError } from './error';
import { NOTION_RECONNECT_MESSAGE } from './types';

/** Tools the issue picker calls; a connection without them cannot serve it. */
const REQUIRED_TOOLS = ['notion-search', 'notion-fetch'] as const;

export function readNotionCredentials(
  credentials: IntegrationCredentials
): Result<McpOAuthCredentials, IntegrationError> {
  return readMcpOAuthCredentials(credentials, NOTION_RECONNECT_MESSAGE);
}

export async function verifyNotionCredentials(
  rawCredentials: IntegrationCredentials
): Promise<Result<void, IntegrationError>> {
  const credentials = readNotionCredentials(rawCredentials);
  if (!credentials.success) return err(credentials.error);

  try {
    const tools = await withMcpClient(credentials.data, listMcpToolNames);
    const missing = REQUIRED_TOOLS.filter((tool) => !tools.includes(tool));
    if (missing.length > 0) {
      return err({
        type: 'generic',
        message: `Notion MCP does not expose ${missing.join(', ')}.`,
      });
    }
    return ok(undefined);
  } catch (error) {
    return err(toNotionIntegrationError(error, 'Failed to verify Notion authorization.'));
  }
}
