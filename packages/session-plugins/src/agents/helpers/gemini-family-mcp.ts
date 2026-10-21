import { cloneMcpEntry, createMcpAdapter, geminiFamilyHttpMcpEntry, stripInjectedMcpHeaders } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * gemini / qwen 系原生条目 → registration(`httpUrl` → `type:'http'` + `url`,去掉咕咕注入的 Accept 头)。
 * 导出它是为了**只有一份方言**:文件读法与 qwen 的项目 / 工作区那几层(impl/qwen/mcp-scopes.ts)共用。
 */
export function geminiFamilyNativeToRegistration(name: string, raw: Record<string, unknown>): McpServerRegistration {
  const entry = cloneMcpEntry(raw) as Record<string, unknown>;
  if ('httpUrl' in entry) {
    const { httpUrl, ...rest } = entry;
    const result = { ...rest, type: 'http', url: httpUrl } as Record<string, unknown>;
    stripInjectedMcpHeaders(result);
    return { name, ...result } as McpServerRegistration;
  }
  return { name, ...entry } as McpServerRegistration;
}

/**
 * Gemini 族(gemini / qwen)的 MCP 形状 — HTTP servers use httpUrl instead of url; Accept header is injected.
 * key: mcpServers, JSON;配置文件路径由各家给。
 */
export function geminiFamilyMcpAdapter(configPath: string) {
  return createMcpAdapter({
    configPath,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(s) {
      const entry = cloneMcpEntry(s) as Record<string, unknown>;
      delete entry.name;
      if (entry.type === 'http') {
        const result: Record<string, unknown> = geminiFamilyHttpMcpEntry(
          (entry.url as string) ?? '',
          (entry.headers as Record<string, string>) ?? {}
        );
        if (entry.env) result.env = entry.env;
        return result;
      }
      delete entry.type;
      return entry;
    },
    fromNative: geminiFamilyNativeToRegistration,
  });
}
