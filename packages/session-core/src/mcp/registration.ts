import type { McpServerRegistration } from '../agents/plugins';
import type { McpServer } from './schemas';

/** Convert a plugin registration to the canonical session-core McpServer shape. */
export function registrationToMcpServer(
  reg: McpServerRegistration,
  providers: string[]
): McpServer {
  const isHttp =
    reg.transport === 'http' ||
    reg.type === 'http' ||
    (typeof reg.url === 'string' && typeof reg.command !== 'string');
  return {
    name: reg.name,
    transport: isHttp ? 'http' : 'stdio',
    command: typeof reg.command === 'string' ? reg.command : undefined,
    args: Array.isArray(reg.args) ? (reg.args as string[]) : undefined,
    url: typeof reg.url === 'string' ? reg.url : undefined,
    headers:
      typeof reg.headers === 'object' && reg.headers !== null
        ? (reg.headers as Record<string, string>)
        : undefined,
    env:
      typeof reg.env === 'object' && reg.env !== null
        ? (reg.env as Record<string, string>)
        : undefined,
    enabled: typeof reg.enabled === 'boolean' ? reg.enabled : undefined,
    cwd: typeof reg.cwd === 'string' ? reg.cwd : undefined,
    timeout: typeof reg.timeout === 'number' ? reg.timeout : undefined,
    oauth:
      (typeof reg.oauth === 'object' && reg.oauth !== null) || reg.oauth === false
        ? (reg.oauth as Record<string, unknown> | false)
        : undefined,
    providers,
  };
}

/** Convert a canonical session-core McpServer to the plugin registration shape. */
export function mcpServerToRegistration(server: McpServer): McpServerRegistration {
  return {
    name: server.name,
    transport: server.transport,
    ...(server.transport === 'http' ? { type: 'http' as const } : {}),
    command: server.command,
    args: server.args,
    url: server.url,
    headers: server.headers,
    env: server.env,
    enabled: server.enabled,
    cwd: server.cwd,
    timeout: server.timeout,
    oauth: server.oauth,
  };
}

/**
 * 「哪一份**记录得更全**」—— 跨 harness 合并时用它挑出**形状**上的代表(命令/地址/参数/环境…)。
 *
 * ⚠️ 这里**不看启用状态**。原先有一条 `if (server.enabled === false) n++`,
 * 它把「这一份显式写了 enabled:false」当成"信息更多"⇒ **停用的那一份赢下合并**,
 * 于是一台「A 家开着、B 家关着」的 server 合并出来是 `enabled: false`,
 * 界面照着它说「已停用」—— 值是真的,**归属是假的**(铁律 7)。
 * ⇒ 启用状态现在由 `mergeMcpServersByName` 逐家收进 `disabledIn`,不再搭这条评分的车。
 * ❌ 别把它加回来:它挑的是**形状**,而 `enabled` 是**值**。
 */
export function mcpServerFieldCount(server: McpServer): number {
  let n = 0;
  if (server.command) n += 10;
  if (server.args?.length) n++;
  if (server.url) n += 10;
  if (server.headers && Object.keys(server.headers).length) n++;
  if (server.env && Object.keys(server.env).length) n++;
  if (server.cwd) n++;
  if (server.timeout !== undefined) n++;
  if (server.oauth !== undefined) n++;
  return n;
}

/**
 * 把各家读到的注册项按名字合并成**一份**跨 harness 视图。
 *
 * ## 为什么这个函数必须只有一份
 *
 * 在它之前,同一段合并逻辑**逐字抄在两处**(`McpService.loadAll` 与
 * `AgentMcpConfigManager.readAll`),于是同一个缺陷也在两处 —— 修一处等于没修。
 * ⇒ 合并这件事属于 `McpServer` 这个类型自己的地盘,和 `registrationToMcpServer` 放在一起。
 *
 * ## 它比原先多做了一件事:**把启用状态逐家留住**
 *
 * `providers` 是并集,而 `enabled` 是逐家的。原先两者被压进一个扁平布尔值,
 * 「A 家开着、B 家关着」就只能说成 true 或 false —— 两个都不是这台 server 的实情。
 *
 * ⇒ 合并之后:
 *   · `disabledIn` = **显式**写了 `enabled: false` 的那几家(`providers` 的子集);
 *   · `enabled: false` **只在每一家都停用时**才出现 —— 这样一颗直接读它的药丸说的是真话;
 *   · 其余情况 `enabled` 缺席(= 没有"全体停用"这回事),细节去看 `disabledIn`。
 *
 * ⚠️ 代表那一份仍按 `mcpServerFieldCount` 挑(形状最全的那份),**但它的 `enabled` 不再决定结果** ——
 *    否则挑中谁就等于替所有家发言。
 */
export function mergeMcpServersByName(
  rows: readonly { readonly providerId: string; readonly server: McpServer }[]
): McpServer[] {
  const byName = new Map<
    string,
    { server: McpServer; providers: string[]; disabledIn: string[] }
  >();
  for (const { providerId, server } of rows) {
    const entry = byName.get(server.name);
    if (entry) {
      if (!entry.providers.includes(providerId)) entry.providers.push(providerId);
      if (mcpServerFieldCount(server) > mcpServerFieldCount(entry.server)) entry.server = server;
    } else {
      byName.set(server.name, { server, providers: [providerId], disabledIn: [] });
    }
    // ⚠️ 只认**显式**的 `false`。缺席 = 这家没表态,默认启用(各家 adapter 的解析口径一致),
    //    把"没表态"记成停用会让一台谁都没关的 server 也带上停用标记。
    if (server.enabled === false) {
      const target = byName.get(server.name)!;
      if (!target.disabledIn.includes(providerId)) target.disabledIn.push(providerId);
    }
  }
  return Array.from(byName.values()).map(({ server, providers, disabledIn }) => {
    const allDisabled = disabledIn.length > 0 && disabledIn.length === providers.length;
    return {
      ...server,
      providers,
      ...(disabledIn.length > 0 ? { disabledIn } : {}),
      // 全体停用 ⇒ 扁平那一格说得出真话;否则不说(❌ 不写 true:那同样是在替没表态的家发言)。
      ...(allDisabled ? { enabled: false as const } : { enabled: undefined }),
    };
  });
}
