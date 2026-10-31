import { defineContract, fallible, liveJob, liveLog, liveModel, liveState } from '@gugu/session-wire';
import { z } from 'zod';
import {
  createHarnessConnectionSchema,
  harnessConnectionSchema,
  harnessConnectionSelectSchema,
  harnessConnectionTargetSchema,
} from './connections';
import { agentRunContextSchema } from '../../agents/agent-run-context';
import { agentAuthStatusSchema } from '../../agents/plugins/capabilities/auth';
import {
  subscriptionPlanReadingSchema,
  subscriptionUsageReadingSchema,
} from '../../agents/plugins/capabilities/subscription';
import {
  agentConfigAuthErrorSchema,
  agentConfigInstallStrategySchema,
  agentConfigListSchema,
  agentConfigMcpErrorSchema,
  agentConfigRefreshErrorSchema,
  agentConfigUninstallStrategySchema,
  agentInstallErrorSchema,
  agentInstallProgressSchema,
  agentUninstallErrorSchema,
  authCommandSchema,
  dependencyStateSchema,
  harnessModelCredentialStatusSchema,
  hostDependencyLedgerSnapshotSchema,
  markUrlHandledCommandSchema,
  mcpServerListSchema,
  mcpServerSchema,
  modelCredentialCommandSchema,
  providerCommandSchema,
  resizeLoginCommandSchema,
  sendLoginInputCommandSchema,
  startLoginCommandSchema,
  subscriptionUsageCommandSchema,
} from './schemas';

const provider = z.object({ providerId: z.string() });

export const agentConfigContract = defineContract({
  listConnections: fallible({ input: provider, data: z.array(harnessConnectionSchema), error: agentConfigAuthErrorSchema }),
  createConnection: fallible({ input: createHarnessConnectionSchema, data: harnessConnectionSchema, error: agentConfigAuthErrorSchema }),
  selectConnection: fallible({ input: harnessConnectionSelectSchema, data: z.void(), error: agentConfigAuthErrorSchema }),
  removeConnection: fallible({ input: harnessConnectionTargetSchema, data: z.void(), error: agentConfigAuthErrorSchema }),
  agents: liveModel({
    key: z.void().optional(),
    states: {
      list: liveState({ data: agentConfigListSchema }),
    },
  }),
  refreshAgents: fallible({
    input: z.object({ providerId: z.string().optional(), refreshShellEnv: z.boolean().optional() }),
    data: z.void(),
    error: agentConfigRefreshErrorSchema,
  }),
  installAgent: liveJob({
    input: provider.extend({ strategy: agentConfigInstallStrategySchema }),
    progress: agentInstallProgressSchema,
    result: dependencyStateSchema,
    error: agentInstallErrorSchema,
  }),
  uninstallAgent: fallible({
    input: provider.extend({ strategy: agentConfigUninstallStrategySchema.optional() }),
    data: dependencyStateSchema,
    error: agentUninstallErrorSchema,
  }),

  startLogin: fallible({
    input: startLoginCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  cancelLogin: fallible({
    input: authCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  sendLoginInput: fallible({
    input: sendLoginInputCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  resizeLogin: fallible({
    input: resizeLoginCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  markUrlHandled: fallible({
    input: markUrlHandledCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  refreshAuthStatus: fallible({
    input: authCommandSchema,
    data: agentAuthStatusSchema,
    error: agentConfigAuthErrorSchema,
  }),
  // 「这家自报的某个自家模型,其 provider 在本机有没有凭据」—— composer 默认预选规则
  // (product spec「模型来源与 UI」)的读数通道。判不出一律 'unknown',
  // 消费方对 'unknown' 必须维持现状。
  modelCredential: fallible({
    input: modelCredentialCommandSchema,
    data: harnessModelCredentialStatusSchema,
    error: agentConfigAuthErrorSchema,
  }),
  loginOutput: liveLog({ key: authCommandSchema }),
  // 「订阅」页(product spec):这家用户自己的登录由谁付钱、什么套餐 / 这一期还剩多少。
  readSubscription: fallible({
    input: providerCommandSchema,
    data: subscriptionPlanReadingSchema,
    error: agentConfigAuthErrorSchema,
  }),
  readSubscriptionUsage: fallible({
    input: subscriptionUsageCommandSchema,
    data: subscriptionUsageReadingSchema,
    error: agentConfigAuthErrorSchema,
  }),

  mcpServers: liveModel({
    key: z.void().optional(),
    states: {
      list: liveState({ data: mcpServerListSchema }),
    },
  }),
  saveMcpServer: fallible({
    input: z.object({ server: mcpServerSchema }),
    data: z.void(),
    error: agentConfigMcpErrorSchema,
  }),
  removeMcpServer: fallible({
    input: z.object({ name: z.string() }),
    data: z.void(),
    error: agentConfigMcpErrorSchema,
  }),
  listMcpForAgent: fallible({
    input: providerCommandSchema,
    data: mcpServerListSchema,
    error: agentConfigMcpErrorSchema,
  }),
});

export type AgentConfigContract = typeof agentConfigContract;

/**
 * 主进程 ↔ agent-config worker 的私有合同(#5683)。renderer 只拿到 `agentConfigContract`。
 *
 * 登录、登录状态、凭据判断都要跑这一家的 CLI —— 跑哪一份由主进程定(读用户在 Agents 设置里的选择),
 * 随请求递进来。worker 自己探只会拿到 PATH 上赢的那份:选了切账号 wrapper 的用户,点「登录」会登进
 * 另一个账号,状态显示的也是另一个账号的。
 */
export const startLoginRuntimeCommandSchema = startLoginCommandSchema.extend({
  runContext: agentRunContextSchema,
});
export const authStatusRuntimeCommandSchema = authCommandSchema.extend({
  runContext: agentRunContextSchema,
});
export const modelCredentialRuntimeCommandSchema = modelCredentialCommandSchema.extend({
  runContext: agentRunContextSchema,
});
export const subscriptionRuntimeCommandSchema = providerCommandSchema.extend({
  runContext: agentRunContextSchema,
});
export const subscriptionUsageRuntimeCommandSchema = subscriptionUsageCommandSchema.extend({
  runContext: agentRunContextSchema,
});

export const agentConfigRuntimeContract = defineContract({
  ...agentConfigContract,
  /**
   * 主进程把「装没装 / 谁装的 / 用户选了哪一份」那一本账递进来(#6101)。
   *
   * ❌ worker 不自己探这件事:它够不到主进程的 KV,自己探出来的那份 `ours` 恒 false、
   * 也看不见用户选的那一份 ⇒ 同一台机器上同一家有两套读数。属主一改就再推一次。
   */
  syncHostDependencyLedger: fallible({
    input: hostDependencyLedgerSnapshotSchema,
    data: z.void(),
    error: agentConfigRefreshErrorSchema,
  }),
  startLogin: fallible({
    input: startLoginRuntimeCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  refreshAuthStatus: fallible({
    input: authStatusRuntimeCommandSchema,
    data: agentAuthStatusSchema,
    error: agentConfigAuthErrorSchema,
  }),
  modelCredential: fallible({
    input: modelCredentialRuntimeCommandSchema,
    data: harnessModelCredentialStatusSchema,
    error: agentConfigAuthErrorSchema,
  }),
  readSubscription: fallible({
    input: subscriptionRuntimeCommandSchema,
    data: subscriptionPlanReadingSchema,
    error: agentConfigAuthErrorSchema,
  }),
  readSubscriptionUsage: fallible({
    input: subscriptionUsageRuntimeCommandSchema,
    data: subscriptionUsageReadingSchema,
    error: agentConfigAuthErrorSchema,
  }),
  /**
   * #6264 这家在这台机器上的会话刚被鉴权拒了(过期 / 被撤销):记下「登录已失效」。
   *
   * 凭据文件还在时 CLI 自己的 status 仍答「已登录」(codex `login status` 只读文件、不联网),
   * 所以这一格只能由真用过它的那一侧(会话)来报。标记落盘,重启后仍在。
   */
  markAuthExpired: fallible({
    input: providerCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
  /**
   * 之后这家的某次会话成功了:撤掉标记并重读一次登录态(量上一次读数用的那份 CLI)。
   * 每一轮成功都会来一次 —— 没标着就是空操作,所以这里❌ 不带 runContext(宿主算它要解析可执行文件)。
   */
  clearAuthExpired: fallible({
    input: providerCommandSchema,
    data: z.void(),
    error: agentConfigAuthErrorSchema,
  }),
});

export type AgentConfigRuntimeContract = typeof agentConfigRuntimeContract;
