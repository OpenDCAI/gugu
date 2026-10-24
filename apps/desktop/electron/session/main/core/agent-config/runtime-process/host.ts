import {
  agentConfigContract,
  agentConfigRuntimeContract,
  type AgentConfigContract,
  type AgentConfigRuntimeContract,
} from '@gugu/session-core/workspace-server';
import {
  exposeWireToWindows,
  forwardController,
  withValidation,
  type ContractClient,
} from '@gugu/session-wire/api';
import { lazyWorker, type WorkerHandle } from '@gugu/session-wire/worker';
import { join } from 'node:path';
import { app } from 'electron';
import { authProgramRole, toPlatform } from '@gugu/session-core/deps/runtime';
import { getHostIpc } from '@main/lib/host-ipc';
import { log } from '@main/lib/logger';
import { buildHostDependencyLedgerSnapshot } from '@main/core/dependencies/host-dependency-ledger';
import { hostDependencyStore } from '@main/core/dependencies/host-dependency-store';
import { appScope } from '@main/app/app-scope';
import { resolveLocalAgentRunContext } from '@main/core/agents/agent-run-context';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { desktopWorkerPath } from '@main/worker-manifest';
import { systemProxyFill } from '@main/utils/systemProxyEnv';
import { loginShellEnv } from '@main/utils/userEnv';
import { err, ok, type Result } from '@gugu/session-shared';
import type { AgentConfigAuthError } from '@gugu/session-core/workspace-server';
import { createHarnessConnection, listHarnessConnections, removeHarnessConnection, selectHarnessConnection, sessionHarnessConnectionId } from '@main/core/agents/harness-connections';
import { connectionFailure } from '@main/core/sessions/subscription-sessions-busy';

const AGENT_CONFIG_WIRE_CHANNEL = 'agent-config-wire';

const agentConfigRuntimeScope = appScope.child('agent-config-runtime-host');
const agentConfigWorker = lazyWorker(
  () => ({
    name: 'agent-config',
    contract: agentConfigRuntimeContract,
    entry: desktopWorkerPath('agent-config'),
    scope: agentConfigRuntimeScope,
    // #6264「登录已失效」标记按「这台机器 × 这家的配置家」记(见 session-runtime auth-expiry-file.ts):
    // 咕咕 server 上放在几个账号共用的数据根(同机账号共用 claude 那份登录,A 发现过期 B 也看得到);
    // 桌面上一台机器一份数据目录,仍放那里。
    env: {
      ...process.env,
      // #6892 harness 的登录态 / 模型目录探针在这个 worker 里起(agy models 要连外网);它在另一个进程,
      // 用不了 buildAgentEnv(那份依赖主进程里的登录 shell 快照),所以在给它环境的这一处补。
      ...systemProxyFill(process.env, loginShellEnv()),
      GUGU_AGENT_AUTH_EXPIRY_FILE: join(
        process.env.GUGU_SERVER_MODE === '1' && process.env.GUGU_SERVER_HOME ? process.env.GUGU_SERVER_HOME : app.getPath('userData'),
        'agent-auth-expiry.json'
      ),
    },
  }),
  {
    onSpawned: (handle) => {
      wireHostDependencyLedger(handle);
    },
  }
);

/**
 * 把这台机器那**一本账**推给 worker,并在它变的时候再推(#6101)。
 *
 * worker 够不到主进程的 KV。没有这条推送时它只能自己探,于是同一台机器上同一家有两套读数:
 * 主进程知道用户选了哪一份、哪一份是咕咕装的,worker 那边 `ours` 恒 false、看不见用户的选择。
 * 与 `withHostResolvedCli` 同一条路子(#5683):**知道答案的那一侧算好了递过去**。
 *
 * 推失败只记一行、不抛:worker 是懒起的,推送失败时它仍然能跑,只是那一刻答的是 PATH 赢家 ——
 * 而下一次账变动会再推一次。❌ 不静默:失败没有日志正是 #6101 第四条要治的东西。
 */
function wireHostDependencyLedger(handle: AgentConfigRuntimeHandle): void {
  const platform = toPlatform(process.platform);
  const push = async (reason: string): Promise<void> => {
    try {
      const snapshot = await buildHostDependencyLedgerSnapshot(platform);
      const result = await handle.client.syncHostDependencyLedger(snapshot);
      if (!result.success) {
        log.warn('[AgentConfigRuntimeHost] worker rejected the host-dependency ledger', {
          reason,
          error: result.error,
        });
        return;
      }
      log.info('[AgentConfigRuntimeHost] host-dependency ledger pushed to worker', {
        reason,
        entries: snapshot.entries.length,
      });
    } catch (error) {
      log.warn('[AgentConfigRuntimeHost] failed to push the host-dependency ledger', {
        reason,
        error: String(error),
      });
    }
  };

  void push('worker-spawned');
  agentConfigRuntimeScope.add(handle.onRestarted(() => void push('worker-restarted')));
  agentConfigRuntimeScope.add(
    hostDependencyStore.onChanged.subscribe(({ hostId, depId }) => {
      // 远端那本账与 worker 无关:worker 只对这台机器答话。
      if (hostId !== 'local') return;
      void push(`ledger-changed:${depId}`);
    })
  );
}

type AgentConfigRuntimeHandle = WorkerHandle<AgentConfigRuntimeContract>;
export type AgentConfigRuntimeClient = ContractClient<AgentConfigContract>;

let rendererWireDispose: (() => void) | null = null;

export async function initializeAgentConfigRuntimeProcess(): Promise<AgentConfigRuntimeHandle> {
  rendererWireDispose ??= exposeRendererWire();
  return agentConfigWorker.get();
}

export async function getAgentConfigRuntimeHandle(): Promise<AgentConfigRuntimeHandle> {
  return initializeAgentConfigRuntimeProcess();
}

export async function getAgentConfigRuntimeClient(): Promise<AgentConfigRuntimeClient> {
  return withHostResolvedCli((await getAgentConfigRuntimeHandle()).client);
}

/**
 * #6264 会话被鉴权拒了 / 之后又成功了 —— 改这台机器上这家的「登录已失效」标记。
 * 私有合同里的两条,renderer 够不到(它只该读,不该写)。每一轮成功都会来一次撤销,没标着时 worker 那边是空操作。
 *
 * 标之前先读一次这家自己的登录态:它说没登录(从没登上 / 退出了)⇒ 这一轮被拒是因为根本没有登录,
 * 不是登录失效了,❌ 标上(10-07 mac1:没 key 的 MiMo 一轮被拒,重启后模型清单写「MiMo Code 登录已失效」)。
 */
export async function markAgentAuthExpired(providerId: string, sessionId?: string): Promise<void> {
  const connectionId = await sessionHarnessConnectionId(sessionId);
  if (sessionId && !connectionId) return;
  const reading = await (await getAgentConfigRuntimeClient()).refreshAuthStatus({ providerId, connectionId });
  if (reading.success && reading.data.kind === 'unauthenticated' && reading.data.reason !== 'expired') return;
  const handle = await getAgentConfigRuntimeHandle();
  const result = await handle.client.markAuthExpired({ providerId, connectionId });
  if (!result.success) throw new Error(`markAuthExpired: ${JSON.stringify(result.error)}`);
}

export async function clearAgentAuthExpired(providerId: string, sessionId?: string): Promise<void> {
  const connectionId = await sessionHarnessConnectionId(sessionId);
  if (sessionId && !connectionId) return;
  const handle = await getAgentConfigRuntimeHandle();
  const result = await handle.client.clearAuthExpired({ providerId, connectionId });
  if (!result.success) throw new Error(`clearAuthExpired: ${JSON.stringify(result.error)}`);
}

export async function disposeAgentConfigRuntimeProcess(): Promise<void> {
  rendererWireDispose?.();
  rendererWireDispose = null;
  await agentConfigWorker.dispose();
}

/**
 * #5683 —— 登录、登录状态、凭据判断跑哪一份 CLI,由这里定,随请求交给 worker。
 *
 * worker 读不到用户在 Agents 设置里的选择,自己探只会拿到 PATH 上赢的那份:选了切账号 wrapper
 * (如 `claude2`)的用户,点「登录」登进的是另一个账号,状态显示的也是另一个账号的 —— 而会话
 * (#5681 之后)跑的却是选中的那份。每次现解析,理由见 `resolveLocalAgentRunContext`。
 *
 * renderer 送来的同名字段不作数:renderer 合同里没有它(校验会剥掉),这里也总是由宿主覆盖。
 */
// 登录 / 登录状态按**程序**(#6335):请求里没带 `program` = 主程序(`primary`);带了伴随程序的
// 依赖 id ⇒ 按它认领的那条腿解析(`authProgramRole`),登的、问的就是那条腿的会话真会跑的那一份
// (Antigravity 终端腿的 `agy`),❌ 不拿主程序去答伴随程序的登录态 —— 两个程序不共享登录。
// 凭据判断(`modelCredential`)问的是主程序自报的模型,仍按 `primary`。
function withHostResolvedCli(
  client: ContractClient<AgentConfigRuntimeContract>
): AgentConfigRuntimeClient {
  const runContextFor = (input: { providerId: string; program?: string; connectionId?: string }) =>
    resolveLocalAgentRunContext(input.providerId, {
      role: input.program === undefined ? 'primary' : authProgramRole(getPlugin(input.providerId), input.program),
      connectionId: input.connectionId,
    });
  return {
    ...client,
    listConnections: (input) => connectionOperation(() => listHarnessConnections(input.providerId)),
    createConnection: (input) => connectionOperation(() => createHarnessConnection(input)),
    removeConnection: (input) => connectionOperation(async () => {
      await removeHarnessConnection(input.providerId, input.connectionId);
      const cancelled = await client.cancelLogin(input);
      if (!cancelled.success) throw new Error('Connection removed, but its sign-in process could not be cancelled');
    }),
    selectConnection: (input) => connectionOperation(async () => {
      const status = await client.refreshAuthStatus({ ...input, runContext: await runContextFor(input) });
      if (!status.success) throw new Error('Cannot read the connection’s sign-in status');
      if (input.connectionId !== 'native' && status.data.kind !== 'authenticated') throw new Error('Sign in before using this connection');
      if (input.providerId === 'codex' || input.providerId === 'claude') {
        // 已有会话跟着默认订阅走:换凭据前要先停掉在跑的会话(#26)。
        const { switchSubscription } = await import('@main/core/sessions/subscription-switch');
        await switchSubscription(input.providerId, input.connectionId, (await runContextFor({ providerId: input.providerId })).env);
      } else {
        await selectHarnessConnection(input.providerId, input.connectionId);
      }
      // Main-provider reading follows the selection; connection login state remains separate.
      const refreshed = await client.refreshAuthStatus({ providerId: input.providerId, runContext: await runContextFor({ providerId: input.providerId }) });
      if (!refreshed.success) throw new Error('Connection selected, but its sign-in status could not be refreshed');
    }),
    startLogin: async (input, options) =>
      client.startLogin({ ...input, runContext: await runContextFor(input) }, options),
    refreshAuthStatus: async (input, options) =>
      client.refreshAuthStatus({ ...input, runContext: await runContextFor(input) }, options),
    modelCredential: async (input, options) =>
      client.modelCredential(
        { ...input, runContext: await resolveLocalAgentRunContext(input.providerId, { role: 'primary', connectionId: input.connectionId }) },
        options
      ),
    // 「订阅」页:按这家声明的那个程序解析(Antigravity 的用量只有终端版 `agy` 报)。
    readSubscription: async (input, options) =>
      client.readSubscription({ ...input, runContext: await subscriptionRunContext(input.providerId, input.connectionId) }, options),
    readSubscriptionUsage: async (input, options) =>
      client.readSubscriptionUsage({ ...input, runContext: await subscriptionRunContext(input.providerId, input.connectionId) }, options),
  };
}

async function connectionOperation<T>(operation: () => Promise<T>): Promise<Result<T, AgentConfigAuthError>> {
  try { return ok(await operation()); }
  catch (error) { return err(connectionFailure(error)); }
}

function subscriptionRunContext(providerId: string, connectionId?: string) {
  const plugin = getPlugin(providerId);
  const descriptor = plugin?.capabilities.subscription;
  const program = descriptor?.kind === 'supported' ? descriptor.program : undefined;
  return resolveLocalAgentRunContext(providerId, { role: plugin ? authProgramRole(plugin, program) : 'primary', connectionId });
}

/** 与 ACP 那条同形(见 acp/runtime-process/host.ts `exposeRendererWire`):开机就挂上,每次 connect 先 `get()`。 */
function exposeRendererWire(): () => void {
  const hostIpc = getHostIpc();
  return exposeWireToWindows(
    {
      ipcMain: hostIpc.ipcMain,
      createMessageChannel: (event) => hostIpc.createMessageChannel(event),
    },
    () => agentConfigWorker.get(),
    (handle) =>
      withValidation(agentConfigContract, forwardController(agentConfigContract, withHostResolvedCli(handle.client)), runtimeWireValidationPolicy()),
    { channel: AGENT_CONFIG_WIRE_CHANNEL }
  );
}

function runtimeWireValidationPolicy() {
  return import.meta.env.DEV ? 'full' : 'inputs';
}
