import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Grok adapter — TOML file with stdio and streamable HTTP servers.
 * Config: ~/.grok/config.toml, key: mcp_servers.
 *
 * Unlike Codex, Grok keeps HTTP `headers` under their canonical key (it does not
 * rename them to `http_headers`) and marks every server with `enabled = true` by
 * default, matching the `grok mcp add` CLI behavior. Transport is inferred from the
 * presence of `url` (HTTP) vs `command` (stdio); there is no `type`/`transport` field.
 */
export function grokMcpAdapter(configPath = '.grok/config.toml') {
  return createMcpAdapter({
    configPath,
    format: 'toml',
    serversKey: 'mcp_servers',
    toNative(s) {
      const { name: _name, transport: _transport, type: _type, ...entry } = s;
      if (typeof entry.enabled !== 'boolean') entry.enabled = true;
      return entry;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      const isHttp = typeof entry.url === 'string' && typeof entry.command !== 'string';
      if (isHttp) {
        entry.transport = 'http';
        entry.type = 'http';
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
