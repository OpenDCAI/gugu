import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Hermes adapter — YAML file with stdio and streamable HTTP servers.
 * Config: ~/.hermes/config.yaml (`$HERMES_HOME/config.yaml`), key: mcp_servers.
 *
 * 原生条目形状取自 hermes 自己把 ACP 会话 server 译成配置条目的那一处
 * (NousResearch/hermes-agent@6f7a7991bb `acp_adapter/server.py` `_mcp_server_config`):
 * stdio = `{command, args, env}`(可带 `cwd`),HTTP = `{url, headers}`;没有 `type` 键,
 * 靠「有 url、没有 command」认 HTTP(`tools/mcp_tool_registration.py` 的同一判法)。
 */
export function hermesMcpAdapter(configPath = '.hermes/config.yaml') {
  return createMcpAdapter({
    configPath,
    format: 'yaml',
    serversKey: 'mcp_servers',
    toNative(s) {
      const { name: _n, type: _t, transport: _transport, ...rest } = s;
      return rest as Record<string, unknown>;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      if (typeof entry.url === 'string' && typeof entry.command !== 'string') {
        entry.transport = 'http';
        entry.type = 'http';
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
