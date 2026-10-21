import type { IMcpBehavior, McpScopedServers } from '@gugu/session-core/agents/plugins';
import { codexMcpAdapter } from './mcp';

/**
 * Codex 的 MCP 照它**自己的分层**读文件(codex-rs rust-v0.156.1 `config/src/loader/mod.rs:121-129`):
 * 用户 `$CODEX_HOME/config.toml` 之上叠 cwd 起往上的 `./.codex/config.toml`(没信任的目录只读不用);
 * 层与层按 TOML 表深合并(同仓 `config/src/overrides.rs` 的 `merge_toml_values`),所以项目里只写
 * `enabled = false` 也是把用户那台关掉。
 *
 * 信任:咕咕的 Codex 会话按次给 cwd 发信任(session-bundle.ts `codexProjectTrustArgs`,`-c projects={ … trusted }`),
 * 所以在咕咕会开会话的目录里,项目层**恒被采用**——这里不再看用户配置里有没有那条 `trust_level`。
 *
 * ❌ 不让它自己列(`codex mcp list --json`):它对每台 HTTP server 做 OAuth 发现(真发网络请求)、读 OAuth 凭据
 * 的 keyring(`codex-mcp/src/mcp/auth.rs:197` `compute_auth_statuses`);而且它不带咕咕那份按次信任,用户没信任过的
 * 项目层会被它漏掉。
 *
 * 只读到这个目录这一层:往上的父目录、git 仓根那一层没有读(未核)。
 */
export function codexScopedMcpAdapter(): IMcpBehavior {
  const user = codexMcpAdapter();
  const project = codexMcpAdapter('.codex/config.toml');
  return {
    ...user,
    async readScopedServers(fs, dirs) {
      const byName = new Map((await user.readServers(fs)).map((reg) => [reg.name, reg]));
      const scoped: McpScopedServers[] = [];
      for (const { dir, fs: dirFs } of dirs) {
        const servers = (await project.readServers(dirFs)).map((reg) => ({ ...byName.get(reg.name), ...reg }));
        if (servers.length > 0) scoped.push({ kind: 'project', dir, servers });
      }
      return scoped;
    },
  };
}
