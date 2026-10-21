import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpOAuthCredentials } from './mcp-oauth';

export class McpToolError extends Error {
  constructor(
    readonly tool: string,
    message: string
  ) {
    super(message);
    this.name = 'McpToolError';
  }
}

/**
 * Open a short-lived MCP session with the stored access token. Renewing the
 * token is the host's job before it hands credentials over, so this never
 * starts an authorization flow: a rejected token fails the call.
 */
export async function withMcpClient<T>(
  credentials: McpOAuthCredentials,
  run: (client: Client) => Promise<T>
): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL(credentials.serverUrl), {
    requestInit: {
      headers: { Authorization: `Bearer ${credentials.tokens.access_token}` },
    },
  });
  const client = new Client({ name: 'gugu', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

export async function listMcpToolNames(client: Client): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor);
  return names;
}

/** Call a tool whose text content is a JSON document and return the parsed value. */
export async function callMcpToolJson(
  client: Client,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const result = await client.callTool({ name: tool, arguments: args });
  const content: unknown[] = Array.isArray(result.content) ? result.content : [];
  const text = content.map(textOf).join('');
  if (result.isError) throw new McpToolError(tool, text || `${tool} failed.`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new McpToolError(tool, `${tool} returned output that is not JSON.`);
  }
}

function textOf(part: unknown): string {
  if (typeof part !== 'object' || part === null) return '';
  const { type, text } = part as { type?: unknown; text?: unknown };
  return type === 'text' && typeof text === 'string' ? text : '';
}
