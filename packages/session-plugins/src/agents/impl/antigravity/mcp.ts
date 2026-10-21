import { createMcpAdapter } from '@gugu/session-core/agents/plugins/helpers';
import type { McpServerRegistration } from '@gugu/session-core/agents/plugins';

/**
 * Antigravity CLI 的 MCP 配置落点。
 *
 * ⚠️ **不是** `~/.gemini/antigravity-cli/`。antigravity 把配置劈成了两个目录:settings 与
 * plugins 在 `~/.gemini/antigravity-cli/`,而 **MCP 与全局 agent 在 `~/.gemini/config/`**。
 * 官方文档 https://antigravity.google/docs/cli/mcp.md 原文:
 *   「**Global server setups:** Configured in `~/.gemini/config/mcp_config.json`.」
 *   「**Workspace local setups:** Configured in your active project under `.agents/mcp_config.json`.」
 * 只登记全局那份:MCP 适配器那条路的 `PluginFs` 根是 `os.homedir()`
 * (`apps/desktop/electron/session/main/core/mcp/services/McpService.ts:42`),工作区相对路径
 * 塞进来只会去家目录下找一个永远不存在的文件(静默读空)。
 */
export const ANTIGRAVITY_MCP_CONFIG_PATH = '.gemini/config/mcp_config.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Antigravity 的 MCP 适配器 —— ❌ **不能用 `passthroughMcpAdapter`**,两个字段名对不上。
 *
 * 顶层键确实是 `mcpServers`(与 canonical 同),但逐服务器的形状有两处偏差,写错就是
 * 一条**连不上的 server**,而界面上它是「已注册」:
 *
 *  1. HTTP 的地址字段叫 **`serverUrl`**,不是 `url`。官方文档同页的加粗警告原文:
 *     「**Remote Connection Schema**: When declaring remote SSE, Streamable HTTP, or
 *      websocket-based MCP connections, you must define the `serverUrl` field.
 *      Legacy fields like `url` or `httpUrl` are not supported.」
 *  2. 启用状态是反的:antigravity 存 **`disabled: boolean`**,咕咕的 `McpServerRegistration`
 *     用 `enabled`。
 *
 * ## 这两条是**实测**出来的,不只是读文档(本机 agy 1.1.19)
 *
 * 让 antigravity 自己写一份,再看它写了什么:
 *   `agy mcp add --type http probe https://example.com/mcp`
 *     → `{"mcpServers":{"probe":{"disabled":false,"serverUrl":"https://example.com/mcp"}}}`
 *   `agy mcp add --env FOO=bar probe2 npx -- -y @modelcontextprotocol/server-filesystem /work`
 *     → `{"args":["-y","…","/work"],"command":"npx","disabled":false,"env":{"FOO":"bar"}}`
 *   `agy mcp disable probe2` → 那一条的 `disabled` 翻成 `true`
 * 反向也验了:手写一份**咕咕这一侧会产出的形状**(serverUrl + headers + disabled;以及
 * command/args/env),`agy mcp list` 把两条都正确列成 `http` / `stdio` 且 `enabled`。
 *
 * ⚠️ 一条与文档冲突的观察,如实记下:同一次实测里,一条用 `url`(而非 `serverUrl`)的条目
 * **也**被 `agy mcp list` 列成了 http。但「列表命令解析得了」≠「连接时用得上」,而文档明写
 * 不支持 —— 所以这里照文档写 `serverUrl`,❌ 不拿这个观察去放宽。
 *
 * ⚠️ 只发 antigravity 自己会发的那几个键(`command` / `args` / `env` / `cwd` / `headers` /
 * `serverUrl` / `disabled`),`transport` / `type` 这类咕咕内部字段在写出去之前剥掉:
 * 它是闭源产品,多塞一个它不认识的键有没有副作用没法证,而少塞没有任何代价。
 */
export function antigravityMcpAdapter(configPath = ANTIGRAVITY_MCP_CONFIG_PATH) {
  return createMcpAdapter({
    configPath,
    format: 'json',
    serversKey: 'mcpServers',
    toNative(server) {
      // ⚠️ **白名单,不是 `...rest`。** 上面那段注释承诺「只发 antigravity 自己会发的那几个键」,
      // 而 `...rest` 做不到:`McpServerRegistration` 还带着 `timeout` / `oauth` 这些咕咕内部字段,
      // 会原样落进用户的 `~/.gemini/config/mcp_config.json`。对一个闭源产品,
      // 多塞一个它不认识的键有没有副作用没法证,而少塞没有任何代价 —— 所以按承诺逐键挑。
      // ❌ 加新键之前先确认 antigravity 真的认它,别顺手放开成透传。
      const entry: Record<string, unknown> = {};
      for (const key of ['command', 'args', 'env', 'cwd', 'headers'] as const) {
        if (server[key] !== undefined) entry[key] = server[key];
      }
      if (typeof server.url === 'string' && server.url) entry.serverUrl = server.url;
      entry.disabled = server.enabled === false;
      return entry;
    },
    fromNative(name, raw) {
      const { serverUrl, disabled, ...rest } = raw;
      const registration: Record<string, unknown> = { name, ...rest };
      if (typeof serverUrl === 'string' && serverUrl) {
        registration.url = serverUrl;
        registration.type = 'http';
      }
      if (typeof disabled === 'boolean') registration.enabled = !disabled;
      // headers 必须是字符串映射才透传;antigravity 允许的其它形状咕咕这一侧没有位置放。
      if ('headers' in registration && !isRecord(registration.headers)) delete registration.headers;
      return registration as McpServerRegistration;
    },
  });
}
