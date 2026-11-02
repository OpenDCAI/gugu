import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpTransportKind = 'streamable-http' | 'sse';

/** SSE has a GET stream and a separate POST endpoint; both must carry the token. */
export function integrationMcpTransport(endpoint: {
  url: string;
  headers: Record<string, string>;
  transport?: McpTransportKind;
  fetch?: typeof fetch;
}) {
  const options = { requestInit: { headers: endpoint.headers }, ...(endpoint.fetch ? { fetch: endpoint.fetch } : {}) };
  return endpoint.transport === 'sse'
    ? new SSEClientTransport(new URL(endpoint.url), {
        ...options,
        eventSourceInit: {
          fetch: (input, init) => {
            const headers = new Headers(init?.headers);
            for (const [name, value] of Object.entries(endpoint.headers)) headers.set(name, value);
            return (endpoint.fetch ?? fetch)(input, { ...init, headers });
          },
        },
      })
    : new StreamableHTTPClientTransport(new URL(endpoint.url), options);
}
