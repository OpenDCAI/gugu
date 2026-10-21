import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { composeAgentSpawnEnv } from '@gugu/session-core/agents/agent-run-context';
import { harnessSelfUpdateLaunch } from '@gugu/session-core/agents/plugins';
import type { AgentProgramRole } from '@gugu/session-core/deps/runtime';
import type { BridgeWait } from '@main/core/agents/acp-bridge';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { resolveAgentHomeEnv } from '@main/core/agents/agent-home';
import { buildAgentEnv } from '@main/core/pty/pty-env';
import type { ResolvedShellProfile } from '@main/core/terminal-shell/types';

/**
 * 「这一家跑起来是什么样」—— 本机的**唯一**算法(#5702)。
 *
 * 终端腿、聊天(ACP)腿、模型清单探针、登录 / 登录状态 / 凭据判断,全部从这里取。
 * worker 进程收得下它(见 `agentRunContextSchema`),而 worker 侧**没有**自己算的那一路。
 *
 * ## 每次现算,❌ 不缓存
 *
 * 用户在设置里换了一份拷贝、改了环境变量、加了额外参数,下一次调用就该生效 —— spec 原文是
 * 「不需要重启应用」。想省的那点开销由各自的输入去省:`resolveAgentExecutable` 选择命中时压根
 * 不碰它的 memo,版本探针按「可执行文件 × 参数」记,模型目录按 `inputsHash` 判(#5605)。
 *
 * ## 为什么 env 必须在**主进程**算
 *
 * worker 那份 `process.env` 是 fork 那一刻的快照:用户之后改了 PATH、换了代理、导出了新的
 * API key,worker 全看不见,而主进程看得见。从前两边各算一份 —— 于是同一台机器上,
 * 终端腿连得上、聊天腿连不上,并且不报错。
 */
export async function resolveLocalAgentRunContext(
  providerId: string,
  options: {
    /**
     * 跑的是哪条腿的程序(#6335)—— **必填**,忘了带编译不过。一家的两条腿可以是两个程序
     * (Antigravity:聊天面板 `agy_acp_server`、终端 `agy`);`primary` = 主程序,给登录这类
     * 「这一家」层面的动作。env / 设置 / agent home 仍按插件算:两条腿是同一家。
     */
    role: AgentProgramRole;
    shellProfile?: ResolvedShellProfile;
    connectionId?: string;
    sessionId?: string;
    sourceSessionId?: string;
    /**
     * 只有真会话启动传(#6394):这一家配对的 ACP 桥接还在下载就等它,并经回调把这一步报进启动进度。
     * 不传 = 不等 —— 模型目录探针这类调用先用随包的桥接,下载在后台接着跑。
     */
    bridgeWait?: BridgeWait;
  }
): Promise<AgentRunContext> {
  const [cli, settings, configRootEnv] = await Promise.all([
    resolveCli(providerId, options.role),
    readProviderSettings(providerId),
    resolveAgentHomeEnv(providerId),
  ]);

  const env = buildAgentEnv({
    agentApiVars: true,
    includeShellVar: true,
    shellProfile: options.shellProfile,
    // 用户在 Agents 设置里填的环境变量。从前只有终端腿读得到这一格 —— 聊天腿、登录、
    // 模型探针全都读不到,于是「我明明在设置里配了 base URL」在一半的界面上不成立。
    providerVars: settings?.env ?? {},
  });
  const selfUpdate = selfUpdateEnv(providerId);
  // 桥接按这份 CLI 的版本配(#6394)。探版本时带上关自更新的那格:别让 `--version` 顺手把它升了。
  const { resolveHostAcpAdapterEntry } = await import('@main/core/agents/acp-bridge');
  const acpAdapterEntry = await resolveHostAcpAdapterEntry(
    providerId,
    options.role,
    cli,
    { ...env, ...selfUpdate },
    options.bridgeWait
  );

  const connection: Partial<AgentRunContext> = providerId === 'claude' || providerId === 'codex'
    ? await import('./harness-connections').then(({ resolveHarnessConnection }) =>
        resolveHarnessConnection(providerId, options))
    : {};
  return {
    cli,
    env,
    selfUpdateEnv: selfUpdate,
    // 同一格的另一半:用户填的额外参数。判据见 `composeAgentSpawnEnv` 的叠放顺序说明。
    extraArgs: parseExtraArgs(settings?.extraArgs),
    // 这一家要不要另一个 node 跑(打包机上的 electron 不带 import attributes 时用它)。
    // worker 从前读自己那份 `process.env.GUGU_NODE_BIN` —— 快照,且模型探针那条路压根没读。
    runtimeExecutable: process.env.GUGU_NODE_BIN?.trim() || undefined,
    ...(acpAdapterEntry ? { acpAdapterEntry } : {}),
    ...connection,
    configRootEnv: { ...configRootEnv, ...connection.configRootEnv },
  };
}

/**
 * 只要「这一家跑起来带什么环境」的那一半,**不解析跑哪一份**(#5702)。
 *
 * 给依赖体检用:它的活就是问某一个绝对路径上的二进制「你是哪个版本」,路径由它自己定。
 * ⚠️ 这里不能改成调 `resolveLocalAgentRunContext` —— 那会去解析可执行文件,而解析器要问
 * 依赖管理器,于是体检 → 算环境 → 解析 → 体检,自己咬自己。
 */
export async function resolveLocalAgentSpawnEnv(
  providerId: string
): Promise<Record<string, string>> {
  const [settings, configRootEnv] = await Promise.all([
    readProviderSettings(providerId),
    resolveAgentHomeEnv(providerId),
  ]);
  return composeAgentSpawnEnv(
    {
      cli: { kind: 'unresolved', message: 'env-only' },
      env: buildAgentEnv({
        agentApiVars: true,
        includeShellVar: true,
        providerVars: settings?.env ?? {},
      }),
      configRootEnv,
      // 体检问的是「会话里跑起来的是哪一版」—— copilot 关了自更新就不再挑缓存里更新的那份,
      // 探针不带同一格就会报出一个会话根本不跑的版本。
      selfUpdateEnv: selfUpdateEnv(providerId),
      extraArgs: [],
    },
    {}
  );
}

/**
 * 解析失败不抛:它作为 `unresolved` 带着解析器自己的诊断原文进 worker,由调用边界照常报出 ——
 * 与从前 worker 自己找不到时用户看到的是同一条路,只是消息换成了真正的原因。
 */
async function resolveCli(providerId: string, role: AgentProgramRole): Promise<AgentRunContext['cli']> {
  // 动态 import:与 harness-model-catalog-wiring 同一个理由 —— 解析器那条链会在加载时读库。
  const { resolveLocalAgentCli } = await import('@main/core/acp/transport/local-acp-process-host');
  try {
    return { kind: 'resolved', path: await resolveLocalAgentCli(providerId, role) };
  } catch (error) {
    return { kind: 'unresolved', message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * ⚠️ 动态 import。设置那条链在加载时就会把整个 settings / plugin-registry 栈拽进来,
 *    而这个模块被 ACP transport 静态引用 —— 静态引会让一批只测路由的单测崩在 registry 的
 *    部分 mock 上(与 `harness-model-catalog.ts` 抬头记的是同一个坑)。
 */
async function readProviderSettings(
  providerId: string
): Promise<{ env?: Record<string, string>; extraArgs?: string } | undefined> {
  const { providerOverrideSettings } = await import(
    '@main/core/settings/provider-settings-service'
  );
  return providerOverrideSettings.getItem(providerId);
}

export function parseExtraArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.trim().split(/\s+/);
}

/** descriptor 声明的关自更新 env(#6186)。argv 那一种只到终端腿,由起终端的那几处读同一份声明。 */
function selfUpdateEnv(providerId: string): Record<string, string> {
  return { ...harnessSelfUpdateLaunch(getPlugin(providerId).capabilities.sessionBundle).env };
}
