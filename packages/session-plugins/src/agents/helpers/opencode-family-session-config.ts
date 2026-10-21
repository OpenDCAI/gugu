import type {
  SessionCapabilityBundle,
  SessionMcpServer,
} from '@gugu/session-core/agents/plugins';
import { sessionRunHome } from './session-bundle';
import { assertSessionMcpStdioEnv, sessionMcpAuthorization } from './session-mcp';

/**
 * opencode 系（opencode 本体 + 它的品牌化 fork MiMo-Code）**那份配置文档**的共用部件。
 *
 * 这一家的会话级注入全靠一个环境变量承载整份 JSON 配置：opencode 叫
 * `OPENCODE_CONFIG_CONTENT`，MiMo 叫 `MIMOCODE_CONFIG_CONTENT`。除了变量名，
 * 文档的 schema 逐字相同（MiMo 的主包目录就叫 `packages/opencode`）。
 *
 * ## 为什么这些函数必须共用，而不是各家抄一份
 *
 * opencode 系遇到自己**读不懂的配置键是走默认、不报错**。所以两家实现一旦漂移，
 * 漂了的那家不会红，它会安安静静地少加载一个 MCP、少注入一段系统提示、或者用回
 * 自己的默认模型 —— 症状离病根隔着两层，极难往回查。
 *
 * 已经有一份先例在 `opencode-family-model-config.ts`（模型那段），以及
 * `opencode-family-permission-config.ts`（权限那段）。这个文件补齐剩下的：
 * 读回调用方已有的配置、拼 MCP 块、以及**撞车就炸**的合并。
 *
 * ❌ 别在任何一家的 session-bundle 里重新拼这些形状。要改，改这里，两家一起动。
 */

/** 一家在这套共用件里的身份：报错串用的名字 + 承载配置文档的环境变量名。 */
export interface OpenCodeFamilyConfigSpec {
  /** 报错串里的人类可读名，例如 `OpenCode` / `MiMo-Code`。 */
  readonly displayName: string;
  /** 承载整份配置文档的环境变量名。 */
  readonly configEnvKey: string;
  /** run-scoped 目录的名字片段，例如 `opencode-capability-runs`。 */
  readonly runHomeSlug: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 只留真正有值的那些 —— 这一维（env）就是原样交给子进程。 */
export function definedEnv(env: SessionCapabilityBundle['env']): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

/**
 * 读回调用方已经放在环境里的那份配置文档。
 *
 * ⚠️ 后续是 **merge 不是替换**：用户自己的 provider / agent / MCP 都在这份文档里，
 * 覆盖掉等于把他的配置清空。读不动就**响亮地炸** —— ❌ 别 catch 成 `{}`，
 * 那会把「用户有一份配置但我们没读懂」静默降级成「用户没有配置」，然后把它抹掉。
 */
export function parseOpenCodeFamilyConfig(
  spec: OpenCodeFamilyConfigSpec,
  raw: string | undefined
): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) throw new Error('top level must be an object');
    return parsed;
  } catch (error) {
    throw new Error(
      `${spec.displayName} session adapter cannot parse bundle.env.${spec.configEnvKey}: ${(error as Error).message}`,
      { cause: error }
    );
  }
}

/**
 * 每次物化分配一个新的 run-scoped 目录：指令文件随 `GUGU_HOME` 走，
 * UUID 保证并行 run 互不覆盖。
 */
export function openCodeFamilyRunHome(
  spec: OpenCodeFamilyConfigSpec,
  bundle: SessionCapabilityBundle
): string {
  return sessionRunHome(bundle, spec.displayName, spec.runHomeSlug);
}

/**
 * 本地(stdio)程序在 opencode 系配置里的形状 —— 它自己的方言,不是各家通用的
 * `{transport, command, args, env}`:`type: 'local'`、`command` 连参数一起是数组、
 * 环境变量叫 `environment`、值里的引用写成 `{env:名字}`(https://opencode.ai/docs/mcp-servers ,
 * https://opencode.ai/docs/config#env-vars)。#6387 实机:照通用形状写进去,opencode serve
 * 对 POST /session 回 400,整条会话起不来。
 */
function openCodeFamilyLocalMcp(server: Extract<SessionMcpServer, { transport: 'stdio' }>): Record<string, unknown> {
  return {
    type: 'local',
    command: [server.command, ...(server.args ?? [])],
    enabled: true,
    ...(server.env
      ? { environment: Object.fromEntries(Object.entries(server.env).map(([name, ref]) => [name, `{env:${ref}}`])) }
      : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
  };
}

/** 咕咕的 MCP server 在这份配置文档里的形状（`mcp` 键下，key = server 名）。 */
export function openCodeFamilyMcpConfig(
  spec: OpenCodeFamilyConfigSpec,
  bundle: SessionCapabilityBundle
): Record<string, unknown> {
  return Object.fromEntries(
    bundle.mcpServers.map((server) => {
      if (server.transport === 'stdio') {
        assertSessionMcpStdioEnv(server, bundle, spec.displayName);
        return [server.name, openCodeFamilyLocalMcp(server)];
      }
      const auth = sessionMcpAuthorization(server, bundle.env, spec.displayName);
      return [
        server.name,
        {
          type: 'remote',
          url: server.url,
          enabled: true,
          ...(auth ? { headers: { Authorization: auth } } : {}),
        },
      ];
    })
  );
}

/**
 * 把咕咕这一侧产出的补丁合进调用方已有的配置文档 —— **撞车就炸**。
 *
 * ❌ 不静默覆盖：用户自己写过的键被咕咕悄悄顶掉，等于替他把他亲手设的东西拆了，
 * 而且他看不见。两个例外是有明确合并语义的：
 *  · `instructions` —— 数组并集（两边的指令文件都该生效，去重）
 *  · `mcp` —— 按 server 名逐个并入；**同名**才算撞车（用户自己有个也叫 `gugu-im` 的
 *    server，咕咕顶掉它就会把 agent 的消息发到别处去）
 * 值完全相等时不算撞车（幂等物化）。
 */
export function mergeOpenCodeFamilyOwnedConfig(
  spec: OpenCodeFamilyConfigSpec,
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
      continue;
    }
    if (key === 'instructions' && Array.isArray(merged[key]) && Array.isArray(value)) {
      merged[key] = [...new Set([...(merged[key] as unknown[]), ...value])];
      continue;
    }
    if (key === 'mcp' && isRecord(merged[key]) && isRecord(value)) {
      const conflicts = Object.keys(value).filter((name) =>
        Object.prototype.hasOwnProperty.call(merged[key] as Record<string, unknown>, name)
      );
      if (conflicts.length > 0) {
        throw new Error(
          `${spec.displayName} config already declares Gugu MCP server name(s): ${conflicts.join(', ')}`
        );
      }
      merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
      continue;
    }
    if (JSON.stringify(merged[key]) === JSON.stringify(value)) continue;
    throw new Error(`${spec.displayName} config merge conflict at '${key}'`);
  }
  return merged;
}

/**
 * 把用户在 `/mcp` 里关掉的那几台写成 `mcp.<名>.enabled = false`(spec `mcp-session-toggle`)。
 *
 * ⚠️ **必须在 `mergeOpenCodeFamilyOwnedConfig` 之后单独做,❌ 不能混进那个 patch。**
 * 那个合并对 `mcp` 下的**同名**是**当场炸**的 —— 那条守卫防的是「咕咕拿自己的 server 顶掉
 * 用户同名的那台」。而这里同名**正是目的**:我们要点名关掉**用户自己的**那一台。
 * 混进 patch 会让一个正当操作撞上一条为完全相反的情形设的守卫。
 *
 * ⚠️ 名字不在这份文档里也照写:用户的 server 多半只在他自己的磁盘配置里,
 * 而 opencode 把 `OPENCODE_CONFIG_CONTENT` 与磁盘配置**合并**(2026-09-06 实测:
 * 磁盘 `enabled:true` + 这里写 `false` ⇒ 探针 server 一次都没被拉起)。
 * ⇒ 这里写的是「这一次不要装载它」,不是「描述它是什么」。
 */
export function applyOpenCodeFamilyDisabledMcp(
  config: Record<string, unknown>,
  disabled: readonly string[]
): Record<string, unknown> {
  if (disabled.length === 0) return config;
  const mcp = isRecord(config.mcp) ? { ...(config.mcp as Record<string, unknown>) } : {};
  for (const name of disabled) {
    const existing = isRecord(mcp[name]) ? (mcp[name] as Record<string, unknown>) : {};
    mcp[name] = { ...existing, enabled: false };
  }
  return { ...config, mcp };
}
