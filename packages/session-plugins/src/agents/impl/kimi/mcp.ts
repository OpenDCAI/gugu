import { cloneMcpEntry, createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Kimi Code adapter —— 外层 `mcpServers`，但内层的传输字段叫 **`transport`**（不是 `type`）。
 *
 * 形状取自它自己的 `McpServerHttpConfigSchema`（一手发行字节，@moonshot-ai/kimi-code@0.38.0）：
 * `{ transport:"http"|"sse", url, headers:{K:V}, auth, bearerTokenEnvVar, enabled,
 *    startupTimeoutMs, toolTimeoutMs, enabledTools, disabledTools }`。
 * 实测：写进 `mcp.json` 之后假端点收到 initialize / notifications/initialized / GET(SSE) /
 * tools/list 四个真实请求，`Authorization` 与自定义头逐字带上，工具也进了模型的工具表（26 → 27）。
 *
 * ⚠️ `transport` 在有 `url` 时可省（它自己会补），但**写成 `type` 是不认的** ——
 * 所以 ❌ 不能直接套 `passthroughMcpAdapter`：那会把咕咕注册项里的 `type` 原样写下去。
 *
 * ⚠️ stdio 那一支**没有实测过**（本轮只验了 http）。所以它在这里原样往返、不做形状翻译，
 *    而 `capabilities.mcp.supportedTransports` 只声明 `http` —— ❌ 别把没验过的形状说成支持。
 */
export function kimiMcpAdapter(configPath = '.kimi-code/mcp.json') {
  return createMcpAdapter({
    configPath,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(s) {
      const entry = cloneMcpEntry(s) as Record<string, unknown>;
      delete entry.name;
      if (typeof entry.url === 'string' && entry.url) {
        const { type: _t, transport: _tr, ...rest } = entry;
        return { transport: 'http', ...rest };
      }
      return entry;
    },
    fromNative(name, raw) {
      const entry = cloneMcpEntry(raw) as Record<string, unknown>;
      if (entry.transport === 'http' || entry.transport === 'sse') {
        const { transport: _t, ...rest } = entry;
        return { name, ...rest, type: 'http' } as McpServerRegistration;
      }
      return { name, ...entry } as McpServerRegistration;
    },
  });
}
