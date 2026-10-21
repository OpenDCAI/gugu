import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Copilot adapter — injects `tools: ['*']` on write; strips it on read.
 * Write: ~/.copilot/mcp-config.json; legacy read: ~/.config/github-copilot/mcp.json.
 */
export function copilotMcpAdapter(
  configPath = '.copilot/mcp-config.json',
  legacyReadPaths = ['.config/github-copilot/mcp.json']
) {
  return createMcpAdapter({
    configPath,
    legacyReadPaths,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(s) {
      const { name: _n, ...rest } = s;
      const entry = cloneMcpEntry(rest) as Record<string, unknown>;
      if (!('tools' in entry)) entry.tools = ['*'];
      return entry;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      if (Array.isArray(entry.tools) && entry.tools.length === 1 && entry.tools[0] === '*') {
        delete entry.tools;
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
