/**
 * ACP 桥入口的**唯一**解析点(#6394)。
 *
 * 每家插件只在 `acp.bridge` 里声明桥从哪来(见 session-core 的 `AcpBridgeSource`),这里把声明解析成
 * 盘上的入口,放进 `AgentRunContext.acpAdapterEntry`;会话(worker)、模型目录探针、ACP 登录都从那一格
 * 取同一个值,插件的 `buildSpawn` 只读 `ctx.adapterEntry`。从前是三种写法三个属主(插件里
 * `require.resolve`、宿主写进程级 env、再加 claude 的配对),#5050 那种「探测与会话两个 adapter」就是这么来的。
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type { AcpBridgeSource } from '@gugu/session-core/agents/plugins';
import type { AgentProgramRole } from '@gugu/session-core/deps/runtime';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { appRuntimeEntryPath } from '@main/worker-manifest';
import { resolveClaudeBridgeEntry, type BridgeWait } from './claude-bridge';
import { resolveAcpBridgeEntry, type BridgeResolveDeps } from './resolve-bridge';
import { claudeBridgeCacheDir, realClaudeBridgeDeps } from './claude-bridge-deps';

export type { BridgeWait } from './claude-bridge';

const realDeps: BridgeResolveDeps = {
  resolveBundled: (specifier) => createRequire(join(app.getAppPath(), 'package.json')).resolve(specifier),
  appRuntimeEntry: appRuntimeEntryPath,
  pairClaude: (cliPath, env, wait) => resolveClaudeBridgeEntry({
    cliPath,
    env,
    cacheDir: claudeBridgeCacheDir(),
    deps: realClaudeBridgeDeps,
    ...(wait ? { wait } : {}),
  }),
};

/**
 * 这一家、这条腿该起哪座桥;`undefined` = 这一家没有桥(CLI 自己讲 ACP)或这条腿不起桥(终端腿)。
 * `wait` 只由真会话启动传(见 `BridgeWait`):配对的那一版还在下载就等它;模型目录探针等调用不等。
 */
export async function resolveHostAcpAdapterEntry(
  providerId: string,
  role: AgentProgramRole,
  cli: AgentRunContext['cli'],
  env: Record<string, string>,
  wait?: BridgeWait
): Promise<string | undefined> {
  if (role !== 'acp' && role !== 'primary') return undefined;
  let bridge: AcpBridgeSource | undefined;
  try {
    bridge = getPlugin(providerId).behavior.acp?.bridge;
  } catch {
    return undefined; // 未知的家:没有插件就没有桥,由调用方各自的「未知 provider」路径去报
  }
  if (!bridge) return undefined;
  return resolveAcpBridgeEntry(bridge, { role, cli, env, ...(wait ? { wait } : {}) }, realDeps);
}
