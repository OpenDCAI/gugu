import type {
  SessionCapabilityBundle,
  SessionMcpServer,
} from '@gugu/session-core/agents/plugins';
import type { McpServer } from '@agentclientprotocol/sdk';

/** Render a stdio server's env map as references, never as secret values. */
export function sessionMcpStdioEnv(server: Extract<SessionMcpServer, { transport: 'stdio' }>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(server.env ?? {}).map(([name, ref]) => [name, `\${${ref}}`]),
  );
}

/** Native config shape used by the JSON/TOML-backed adapters. */
export function sessionMcpStdioConfig(
  server: Extract<SessionMcpServer, { transport: 'stdio' }>,
): Record<string, unknown> {
  return {
    transport: 'stdio',
    command: server.command,
    args: [...(server.args ?? [])],
    ...(server.env ? { env: sessionMcpStdioEnv(server) } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  };
}

/** ACP session/new shape for a stdio server. Values stay as child-env references. */
export function sessionMcpStdioProtocol(
  server: Extract<SessionMcpServer, { transport: 'stdio' }>,
): Extract<McpServer, { command: string }> & { type: 'stdio' } {
  // ACP v1 models stdio as an untagged variant, while Gugu's start envelope keeps an
  // explicit `type` discriminator so it can validate the renderer/main boundary. The
  // extra field is ignored by ACP peers and retained by the product wire schema.
  return {
    type: 'stdio',
    name: server.name,
    command: server.command,
    args: [...(server.args ?? [])],
    env: Object.entries(server.env ?? {}).map(([name, ref]) => ({
      name,
      value: `\${${ref}}`,
    })),
  } as Extract<McpServer, { command: string }> & { type: 'stdio' };
}

/**
 * 物化之前确认每一条 env 引用都指得到东西。
 *
 * ⚠️ **判据按归属分家**,与本文件上游 `assertPackageDeclaresMcpServers` 的
 * `owner !== 'user'` 同一条规矩:
 *
 * - 咕咕自己那几台(`owner !== 'user'`):值由咕咕现算(会话的 bearer token 之类),
 *   空值 = 咕咕自己坏了 ⇒ 空白也要响亮失败。
 * - 用户自己那几台(`owner === 'user'`):值原样来自用户的 harness 配置,**空字符串是合法且
 *   有意的**(ChatGPT.app 就往 `~/.codex/config.toml` 写 `NODE_REPL_..._BROWSER = ""`
 *   表示"这段 instructions 不启用",codex 自己 `codex mcp list --json` 也照样报 enabled)。
 *   拿咕咕的尺子否决用户合法的配置,症状是**整条会话开不起来** —— 而这不是咕咕能替用户
 *   决定的事。⇒ 只有引用**根本没造出来**(`undefined`)才抛,那才是咕咕自己的断链。
 */
export function assertSessionMcpStdioEnv(
  server: Extract<SessionMcpServer, { transport: 'stdio' }>,
  bundle: SessionCapabilityBundle,
  adapterId: string,
): void {
  const ownedByUser = server.owner === 'user';
  for (const ref of Object.values(server.env ?? {})) {
    const value = bundle.env[ref];
    const missing = ownedByUser ? value === undefined : !value?.trim();
    if (missing) {
      throw new Error(
        `${adapterId} session adapter MCP '${server.name}' requires env '${ref}'`,
      );
    }
  }
}

/**
 * 一台 http server 的 `Authorization` 值(会话里现算的 bearer,在 `env[server.authorizationEnv]`)。
 *
 * 声明了却拿不到就响亮失败:带着一个没有 Authorization 头的 server 起会话,症状是 agent 手里有个工具、
 * 一调就 401,而病根在几层之外。没声明 `authorizationEnv` 的返回 `undefined`。
 */
export function sessionMcpAuthorization(
  server: Exclude<SessionMcpServer, { transport: 'stdio' }>,
  env: Readonly<Record<string, string | undefined>>,
  adapterId: string,
): string | undefined {
  if (!server.authorizationEnv) return undefined;
  const value = env[server.authorizationEnv]?.trim();
  if (!value) {
    throw new Error(
      `${adapterId} session adapter MCP '${server.name}' requires authorization env '${server.authorizationEnv}'`,
    );
  }
  return value;
}

/**
 * ACP `session/new.mcpServers`:stdio 的 env 写成子进程环境引用,http 带 `Authorization` 头。
 * `extra` 给每一条补这一家的原生字段(CodeBuddy 的 `_meta.defer_loading`),不给就是 ACP 标准形状。
 */
export function sessionMcpProtocolServers(
  bundle: SessionCapabilityBundle,
  adapterId: string,
  extra: (server: SessionMcpServer) => Record<string, unknown> = () => ({}),
) {
  return bundle.mcpServers.map((server) => {
    if (server.transport === 'stdio') {
      assertSessionMcpStdioEnv(server, bundle, adapterId);
      return { ...sessionMcpStdioProtocol(server), ...extra(server) };
    }
    const credential = sessionMcpAuthorization(server, bundle.env, adapterId);
    return {
      type: 'http' as const,
      name: server.name,
      url: server.url,
      headers: credential ? [{ name: 'Authorization', value: credential }] : [],
      ...extra(server),
    };
  });
}
