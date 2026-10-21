import { geminiFamilyMcpAdapter } from '../../helpers/gemini-family-mcp';

/**
 * Qwen adapter — same as Gemini (httpUrl ↔ url, Accept header).
 * Config: ~/.qwen/settings.json, key: mcpServers, JSON.
 */
export function qwenMcpAdapter(configPath = '.qwen/settings.json') {
  return geminiFamilyMcpAdapter(configPath);
}
