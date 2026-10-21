import { createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Amp adapter — passthrough, uses the literal `amp.mcpServers` JSON key.
 * Write: ~/.config/amp/settings.json; legacy read: ~/.amp/config.json.
 */
export function ampMcpAdapter(
  configPath = '.config/amp/settings.json',
  legacyReadPaths = ['.amp/config.json']
) {
  return createMcpAdapter({
    configPath,
    legacyReadPaths,
    legacyServersKey: 'mcpServers',
    format: 'json',
    serversKey: 'amp.mcpServers',
    serversKeyIsLiteral: true,
    toNative(s) {
      const { name: _n, ...rest } = s;
      return rest as Record<string, unknown>;
    },
    fromNative(name, raw) {
      return { name, ...raw } as McpServerRegistration;
    },
  });
}
