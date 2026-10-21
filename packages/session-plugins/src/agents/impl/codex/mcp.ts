import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Codex adapter — TOML file with stdio and streamable HTTP servers.
 * Config: ~/.codex/config.toml, key: mcp_servers.
 */
export function codexMcpAdapter(configPath = '.codex/config.toml') {
  return createMcpAdapter({
    configPath,
    format: 'toml',
    serversKey: 'mcp_servers',
    toNative(s) {
      const entry = cloneMcpEntry(s) as Record<string, unknown>;
      const isHttp =
        entry.transport === 'http' ||
        entry.type === 'http' ||
        (typeof entry.url === 'string' && typeof entry.command !== 'string');

      delete entry.name;
      delete entry.transport;
      delete entry.type;

      if (isHttp && entry.headers && !entry.http_headers) {
        entry.http_headers = entry.headers;
        delete entry.headers;
      }

      return entry;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      const isHttp = typeof entry.url === 'string' && typeof entry.command !== 'string';

      if (isHttp) {
        if (entry.http_headers && !entry.headers) {
          entry.headers = entry.http_headers;
        }
        delete entry.http_headers;
        entry.transport = 'http';
        entry.type = 'http';
      }

      return { name, ...entry } as McpServerRegistration;
    },
  });
}
