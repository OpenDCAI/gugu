import { opencodeFamilyMcpAdapter } from '../../helpers/opencode-family-mcp';

/**
 * MiMo Code adapter — OpenCode fork sharing the same MCP config schema
 * (type:'remote'/url for HTTP; type:'local'/command[] for stdio).
 * Write: ~/.config/mimocode/mimocode.json; read lower-priority config.json and
 * project-local .mimocode/mimocode.json for existing installs.
 */
export function mimocodeMcpAdapter(
  configPath = '.config/mimocode/mimocode.json',
  // .jsonc 变体与各自的 .json 同层:MiMo 0.1.13 发行字节的候选表含全局与 .mimocode/ 的
  // .jsonc 名,且 .json/.jsonc 同走 jsonc 解析 —— 只扫 .json 会对 .jsonc 用户静默返回空。
  legacyReadPaths = [
    '.config/mimocode/config.json',
    '.mimocode/mimocode.json',
    '.mimocode/mimocode.jsonc',
  ],
  companionReadPaths = ['.config/mimocode/mimocode.jsonc']
) {
  return opencodeFamilyMcpAdapter(configPath, legacyReadPaths, companionReadPaths);
}
