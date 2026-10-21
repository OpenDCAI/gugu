import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Cursor adapter — HTTP servers drop `type`, but `url` stays.
 * Config: ~/.cursor/mcp.json, key: mcpServers, JSON.
 */
export function cursorMcpAdapter(configPath = '.cursor/mcp.json') {
  return createMcpAdapter({
    configPath,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(s) {
      const { name: _n, type: _t, ...rest } = s as McpServerRegistration & { type?: string };
      return rest as Record<string, unknown>;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw);
      if ('url' in entry && !('command' in entry)) {
        (entry as Record<string, unknown>).type = 'http';
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
