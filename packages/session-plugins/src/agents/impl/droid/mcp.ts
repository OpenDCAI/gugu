import { passthroughMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';

/**
 * Droid (Factory AI) adapter — passthrough, uses mcpServers JSON key.
 * Write: ~/.factory/mcp.json; legacy read: old Droid/Factory config paths.
 */
export function droidMcpAdapter(
  configPath = '.factory/mcp.json',
  legacyReadPaths = ['.droid/settings.json', '.factory/config.json']
) {
  return passthroughMcpAdapter(configPath, legacyReadPaths);
}
