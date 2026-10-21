import { opencodeFamilyMcpAdapter } from '../../helpers/opencode-family-mcp';

/** OpenCode:写 ~/.config/opencode/opencode.json;旧版读 ~/.opencode/config.json。 */
export function opencodeMcpAdapter(
  configPath = '.config/opencode/opencode.json',
  legacyReadPaths = ['.opencode/config.json'],
  // 厂商把 `.jsonc` 当第一等配置名(#4593:只扫 .json 会对首选 .jsonc 的用户静默返回空)。
  companionReadPaths = ['.config/opencode/opencode.jsonc']
) {
  return opencodeFamilyMcpAdapter(configPath, legacyReadPaths, companionReadPaths);
}
