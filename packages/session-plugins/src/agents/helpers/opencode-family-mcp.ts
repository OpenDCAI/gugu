import { INJECTED_MCP_ACCEPT, cloneMcpEntry, createMcpAdapter, ensureMcpHeader, stripInjectedMcpHeaders } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * OpenCode 族(opencode / mimocode)的 MCP 形状 — type:'remote'/url for HTTP; type:'local'/command[] for stdio。
 * key: mcp;读写路径由各家给。
 */
export function opencodeFamilyMcpAdapter(
  configPath: string,
  legacyReadPaths: string[],
  companionReadPaths: string[]
) {
  return createMcpAdapter({
    configPath,
    legacyReadPaths,
    companionReadPaths,
    format: 'json',
    serversKey: 'mcp',
    toNative(s) {
      const entry = cloneMcpEntry(s) as Record<string, unknown>;
      delete entry.name;
      const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : true;
      if (entry.type === 'http') {
        const url = (entry.url as string) ?? '';
        const baseHeaders = (entry.headers as Record<string, string>) ?? {};
        const headers: Record<string, string> = { ...baseHeaders };
        ensureMcpHeader(headers, 'Accept', INJECTED_MCP_ACCEPT);
        const result: Record<string, unknown> = {
          type: 'remote',
          url,
          headers,
          enabled,
        };
        if (entry.env) result.env = entry.env;
        if (entry.timeout !== undefined) result.timeout = entry.timeout;
        if (entry.oauth !== undefined) result.oauth = entry.oauth;
        return result;
      }
      // stdio
      const cmdVec: string[] = [];
      if (typeof entry.command === 'string' && entry.command) cmdVec.push(entry.command as string);
      if (Array.isArray(entry.args)) cmdVec.push(...(entry.args as string[]));
      if (!cmdVec.length && enabled === false) return { enabled: false };
      const result: Record<string, unknown> = { type: 'local', command: cmdVec, enabled };
      if (entry.env) result.environment = entry.env;
      if (entry.cwd !== undefined) result.cwd = entry.cwd;
      if (entry.timeout !== undefined) result.timeout = entry.timeout;
      return result;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      if (entry.type === 'remote') {
        const { type: _t, ...rest } = entry;
        const result = { ...rest, type: 'http' } as Record<string, unknown>;
        stripInjectedMcpHeaders(result);
        return { name, ...result } as McpServerRegistration;
      }
      if (entry.type === 'local' && Array.isArray(entry.command)) {
        const cmdArr = entry.command as string[];
        const [command, ...args] = cmdArr;
        const result: Record<string, unknown> = {};
        if (command) result.command = command;
        if (args.length) result.args = args;
        if (entry.environment) result.env = entry.environment;
        else if (entry.env) result.env = entry.env;
        if (typeof entry.enabled === 'boolean') result.enabled = entry.enabled;
        if (typeof entry.cwd === 'string') result.cwd = entry.cwd;
        if (typeof entry.timeout === 'number') result.timeout = entry.timeout;
        return { name, ...result } as McpServerRegistration;
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
