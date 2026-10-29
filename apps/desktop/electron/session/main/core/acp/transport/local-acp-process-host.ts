import { diskFileStamp } from '@gugu/session-core/exec';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { assertSessionRuntimeCompatible } from '@main/core/agents/session-runtime-compatibility';
import { composeAgentSpawnEnv, type AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context';
import { resolveAgentExecutable } from '@main/core/sessions/impl/resolve-agent-executable';
import { agentProgramFor, type AgentProgramRole } from '@gugu/session-core/deps/runtime';
import { localDependencyManager } from '@main/core/dependencies/dependency-managers';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';

/**
 * 这一家在本机跑**哪一份 CLI** —— 读用户在 Agents 设置里的选择(#5681)。
 *
 * Chat UI 会话的 start / resume(`runtime-process/host.ts`)与模型清单探测(下面)都从这里取,
 * 入参与终端腿(`local-session.ts`)逐项相同。❌ 别在别处另拼一份 `resolveAgentExecutable`
 * 的入参,也❌ 别让 worker 自己探:worker 读不到 selection,只会拿到 PATH 上赢的那份。
 */
export async function resolveLocalAgentCli(providerId: string, role: AgentProgramRole): Promise<string> {
  // 按**角色**取程序(#6335):某条腿被伴随程序认领时(Antigravity 终端腿 → `agy`),选择、探测缓存、
  // PATH 上找的名字全换成那一行的。❌ 别回到 `binaryNames[0]` —— 它只说主程序。
  const { dependencyId, binaryName } = agentProgramFor(getPlugin(providerId), role);
  const executionContext = new LocalExecutionContext();
  try {
    return await resolveAgentExecutable({
      providerId,
      dependencyId,
      binaryName,
      ctx: executionContext,
      hostDependencyStore,
      cachedStatePath: localDependencyManager.get(dependencyId as never)?.path,
      installations: localDependencyManager.getHostDependency(dependencyId as never)?.installations,
    });
  } finally {
    executionContext.dispose();
  }
}

/**
 * 本机版本探针共用的执行上下文。探针缓存按执行上下文分格,每次新建一个就永远查不中 ——
 * 于是每条 ACP 会话、每次 `session_list_harnesses` 都要真探一遍(mac1 实测列一次 ~940 ms)。
 * 本机只有一个答案,共用这一个;就地升级由缓存键里的真实路径 + mtime + size(`diskFileStamp`)识别。
 */
export const localLaunchProbeContext = new LocalExecutionContext();

/**
 * 聊天(ACP)腿与模型清单探针的运行上下文 —— 与终端腿**同一个**算法(#5702)。
 *
 * 从前这里自己拼 env(`buildAgentEnv` + `resolveAgentHomeEnv`),而终端腿在
 * `local-session.ts` 里另拼一份。差别不是理论上的:用户在 Agents 设置里填的
 * 环境变量与额外参数**只进终端腿**,聊天腿、登录、模型探针一个都拿不到。
 *
 * 返回里同时带上 `runContext`,是为了让调用方用 `composeAgentSpawnEnv` 去叠 provider
 * 自己的命令 env —— ❌ 别自己写 `{ ...agentEnv, ...spawn.env }`:那样独立配置根会被
 * provider 的同名变量顶掉,而叠放顺序全产品只该有一处。
 */
export async function resolveLocalAcpSpawnContext(
  providerId: string
): Promise<{ cli: string; agentEnv: Record<string, string>; runContext: AgentRunContext }> {
  const plugin = getPlugin(providerId);
  // 聊天(ACP)腿与模型清单探针都是 acp 那条腿的程序。
  const runContext = await resolveLocalAgentRunContext(providerId, { role: 'acp' });
  if (runContext.cli.kind === 'unresolved') throw new Error(runContext.cli.message);

  const compatibleCli = await assertSessionRuntimeCompatible({
    providerId,
    surface: 'acp',
    descriptor: plugin.capabilities.sessionBundle,
    executable: runContext.cli.path,
    versionLine: plugin.capabilities.hostDependency.versionLine,
    executionContext: localLaunchProbeContext,
    fileStamp: diskFileStamp,
    // 这一格从前这条路上根本没读 ⇒ 打包机上的 electron 跑不动某些适配器时,终端腿换了
    // 运行时、模型探针没换,于是探到的清单与真会话能跑的不是一回事。
    runtimeExecutable: runContext.runtimeExecutable,
  });

  return { cli: compatibleCli, agentEnv: composeAgentSpawnEnv(runContext), runContext };
}
