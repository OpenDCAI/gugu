import { geminiFamilyMcpAdapter } from '../../helpers/gemini-family-mcp';

/** Gemini CLI:~/.gemini/settings.json,key mcpServers。 */
export function geminiMcpAdapter(configPath = '.gemini/settings.json') {
  return geminiFamilyMcpAdapter(configPath);
}
