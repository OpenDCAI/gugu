import { z } from 'zod';
import { agentAuthStatusSchema } from '../../agents/plugins/capabilities/auth';
import {
  INSTALL_METHODS,
  INSTALL_PHASES,
  installOptionSchema,
} from '../../host-dependencies/capability';
import { hostDependencySelectionSchema } from '../../host-dependencies/runtime/types';
import { mcpServerSchema } from '../../mcp';
import { runtimeUnavailableErrorSchema } from '../shared/schemas';

export const dependencyCategorySchema = z.enum(['core', 'agent']);
export const dependencyStatusSchema = z.enum(['available', 'missing', 'error']);

export const dependencyStateSchema = z.object({
  id: z.string(),
  category: dependencyCategorySchema,
  status: dependencyStatusSchema,
  version: z.string().nullable(),
  path: z.string().nullable(),
  checkedAt: z.number(),
  error: z.string().optional(),
  latestVersion: z.string().nullable().optional(),
  updateAvailable: z.boolean().optional(),
});

/** 失败那一刻最后一次进度(见 InstallCommandError 的 lastProgress)。 */
const lastInstallProgressSchema = z.object({
  phase: z.enum(INSTALL_PHASES),
  bytesDone: z.number().nonnegative().optional(),
  bytesTotal: z.number().positive().optional(),
  bytesPerSecond: z.number().nonnegative().optional(),
  etaSeconds: z.number().nonnegative().optional(),
  elapsedMs: z.number().nonnegative(),
});

export const installCommandErrorSchema = z.union([
  z.object({
    type: z.literal('cancelled'),
    message: z.string(),
    output: z.string(),
    stage: z.string().optional(),
    lastProgress: lastInstallProgressSchema.optional(),
    artifacts: z
      .array(
        z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal('stalled'),
    message: z.string(),
    output: z.string(),
    idleMs: z.number().int().nonnegative(),
    stage: z.string().optional(),
    lastProgress: lastInstallProgressSchema.optional(),
    artifacts: z
      .array(
        z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal('permission-denied'),
    message: z.string(),
    output: z.string(),
    exitCode: z.number().int().optional(),
    stage: z.string().optional(),
    artifacts: z
      .array(
        z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({
    type: z.literal('command-failed'),
    message: z.string(),
    output: z.string(),
    exitCode: z.number().int().optional(),
    stage: z.string().optional(),
    lastProgress: lastInstallProgressSchema.optional(),
    artifacts: z
      .array(
        z.object({
          path: z.string(),
          bytes: z.number().int().nonnegative().nullable(),
        }),
      )
      .optional(),
  }),
  z.object({ type: z.literal('pty-open-failed'), message: z.string() }),
  // 这儿没有安装通道(远端主机 / 无头 runtime)—— 一条命令都没跑,所以没有 output。
  z.object({ type: z.literal('unsupported-host'), message: z.string() }),
]);

export const agentConfigUnknownProviderErrorSchema = z.object({
  type: z.literal('unknown-provider'),
  providerId: z.string(),
});
export const agentConfigInvalidStateErrorSchema = z.object({
  type: z.literal('invalid-state'),
  message: z.string(),
  // 因「这一家有会话正在工作」没切订阅:界面据此按自己的语言写提示;没有这个字段(旧主机)就照 `message` 显示。
  sessionsBusy: z.object({ providerId: z.string(), count: z.number().int() }).optional(),
});
export const agentConfigIoErrorSchema = z.object({
  type: z.literal('io'),
  path: z.string().optional(),
  message: z.string(),
});

export const agentConfigErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  installCommandErrorSchema,
  runtimeUnavailableErrorSchema,
]);

export const agentInstallErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  z.object({ type: z.literal('no-install-command'), providerId: z.string() }),
  installCommandErrorSchema,
  z.object({ type: z.literal('not-detected-after-install'), providerId: z.string() }),
  runtimeUnavailableErrorSchema,
]);

export const agentUninstallErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  z.object({ type: z.literal('no-uninstall-strategy'), providerId: z.string() }),
  z.object({ type: z.literal('no-uninstall-command'), providerId: z.string() }),
  z.object({ type: z.literal('still-present'), providerId: z.string() }),
  installCommandErrorSchema,
  runtimeUnavailableErrorSchema,
]);

export const agentConfigAuthErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  runtimeUnavailableErrorSchema,
]);
export const agentConfigMcpErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  agentConfigIoErrorSchema,
  runtimeUnavailableErrorSchema,
]);
export const agentConfigRefreshErrorSchema = z.union([
  agentConfigUnknownProviderErrorSchema,
  agentConfigInvalidStateErrorSchema,
  runtimeUnavailableErrorSchema,
]);

// ❌ 这里曾经还有一支 `{kind:'custom', command}`:调用方递一条命令、runtime 直接跑,
// 完全绕过 `HostDependencyManager`(自己 probe、自己判状态)。删掉了(#6098)——
// 安装只有托管安装一条路,而「让调用方递一条要执行的命令」本身就是第二本账。
export const agentConfigInstallStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('package-manager'), method: z.enum(INSTALL_METHODS).optional() }),
]);

export const agentConfigUninstallStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('package-manager'), method: z.enum(INSTALL_METHODS).optional() }),
]);

export const authPendingUrlSchema = z.object({
  id: z.string(),
  url: z.url(),
});

/**
 * 协议登录(`acp-authenticate`)那一趟的结局 —— 终端登录没有这一格(它的结局就是进程退出码)。
 *
 * ⚠️ 三态分开,❌ 不合成「结束了」:成功要关窗重读,失败要把厂商原话摆给用户,取消什么都不说。
 */
export const authLoginOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('succeeded') }),
  z.object({ kind: z.literal('failed'), message: z.string() }),
  z.object({ kind: z.literal('cancelled') }),
]);

export const authLoginStateSchema = z.object({
  methodId: z.string(),
  startedAt: z.number(),
  /**
   * 这趟登录跑在哪:`terminal` = 起一个终端跑 `<cli> login`(cli-login);`acp-authenticate` = 起它的
   * ACP 进程发 `authenticate`,浏览器由厂商自己拉起,界面上没有终端。缺席按 `terminal` 读(老快照)。
   */
  transport: z.enum(['terminal', 'acp-authenticate']).optional(),
  /**
   * 登录链接。`terminal` 那条路上它是**要替用户打开**的授权链接(设备码流程);`acp-authenticate` 上
   * 厂商已经自己开过浏览器了,它只是「浏览器没打开时点这里」的备用链接 —— ❌ 不再自动打开一次。
   */
  pendingUrl: authPendingUrlSchema.nullable(),
  exit: z
    .object({
      exitCode: z.number().int().nullable(),
      signal: z.string().nullable(),
    })
    .nullable(),
  outcome: authLoginOutcomeSchema.nullable().optional(),
});

export const authStatusModelStateSchema = z.object({
  status: agentAuthStatusSchema,
  login: authLoginStateSchema.nullable(),
});

export const agentConfigEntrySchema = z.object({
  providerId: z.string(),
  name: z.string(),
  install: dependencyStateSchema,
  /** 主程序的登录态(没有伴随程序的家就只有这一份)。 */
  auth: authStatusModelStateSchema,
  /**
   * 伴随程序各自的登录态(#6335),键是伴随程序的依赖 id(`auth.programs` 的键)。
   * 两个程序不共享登录 ⇒ 各有各的读数与登录进程;只有声明了程序登录的家才会出现这一格。
   */
  programAuth: z.record(z.string(), authStatusModelStateSchema).optional(),
  connectionAuth: z.record(z.string(), authStatusModelStateSchema).optional(),
  installOptions: z.array(installOptionSchema),
});

export const agentConfigListSchema = z.record(z.string(), agentConfigEntrySchema);

/**
 * 安装到哪一步了。顺序即先后，界面据此说人话，❌ 不许倒退。
 * `starting` = 命令刚起来、安装器还没开口。
 */
export const agentInstallPhaseSchema = z.enum(INSTALL_PHASES);

/**
 * 一次安装的实时读数。
 *
 * 判据（product spec）：**拿不到分母就不给百分比**。所以
 * `bytesTotal` 是可缺席的，而界面必须据此在「有百分比」和「只有已完成量+速度」两种形态
 * 之间切换 —— ❌ 不许用一个估算出来的分母凑出进度条。
 */
export const agentInstallProgressSchema = z.object({
  providerId: z.string(),
  phase: agentInstallPhaseSchema,
  /** 已经装进来的字节（实测落点目录的增长，不是推算）。 */
  bytesDone: z.number().nonnegative().optional(),
  /** 一共该有多大。**缺席 = 不画百分比**。 */
  bytesTotal: z.number().positive().optional(),
  /** 实测速度（字节/秒）。 */
  bytesPerSecond: z.number().nonnegative().optional(),
  /** 按当前速度还要多久（秒）。只有分母已知时才有。 */
  etaSeconds: z.number().nonnegative().optional(),
  /** 命令起来到现在多久。 */
  elapsedMs: z.number().nonnegative(),
  /**
   * 一次点击要装几个程序时(#6335:Antigravity 两条腿是两个程序),这一条读数属于第几个。
   * 字节数与比例都只说**当前这个程序** —— 两个程序的分母不会同时知道,❌ 不拼一个合计百分比。
   * 只有一个程序的家没有这一格。
   */
  part: z
    .object({
      index: z.number().int().positive(),
      count: z.number().int().positive(),
      name: z.string(),
    })
    .optional(),
});

/**
 * 登录相关的每一条命令都带上「登哪个程序」(#6335):缺席 = 主程序(与改之前逐字节一致),
 * 给了 = 那个伴随程序的依赖 id(`auth.programs` 的键)。一个程序一条登录进程、一份读数。
 */
const authProgramField = { program: z.string().optional(), connectionId: z.string().optional() };

export const startLoginCommandSchema = z.object({
  providerId: z.string(),
  methodId: z.string(),
  /** #6264 从别的电脑发起(浏览器不在这台机器上):跑这家声明的 `headlessArgs`。 */
  headless: z.boolean().optional(),
  ...authProgramField,
});

export const providerCommandSchema = z.object({ providerId: z.string(), connectionId: z.string().optional() });
export const authCommandSchema = providerCommandSchema.extend(authProgramField);
export const sendLoginInputCommandSchema = authCommandSchema.extend({ data: z.string() });
// product spec 默认预选规则的读数通道:「这个自家模型的 provider 有没有本机凭据」。
export const modelCredentialCommandSchema = providerCommandSchema.extend({ modelId: z.string() });
// product spec 的读数通道。`force`:只在「现在查」时才问的那几家(Claude),这一次真去问。
export const subscriptionUsageCommandSchema = providerCommandSchema.extend({ force: z.boolean().optional() });
export const harnessModelCredentialStatusSchema = z.enum([
  'credentialed',
  'uncredentialed',
  'unknown',
]);
export const resizeLoginCommandSchema = authCommandSchema.extend({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const markUrlHandledCommandSchema = authCommandSchema.extend({ urlId: z.string() });

export const mcpServerListSchema = z.array(mcpServerSchema);
export { mcpServerSchema };

export type AgentConfigError = z.infer<typeof agentConfigErrorSchema>;
export type AgentInstallError = z.infer<typeof agentInstallErrorSchema>;
export type AgentUninstallError = z.infer<typeof agentUninstallErrorSchema>;
export type AgentConfigAuthError = z.infer<typeof agentConfigAuthErrorSchema>;
export type AgentConfigMcpError = z.infer<typeof agentConfigMcpErrorSchema>;
export type AgentConfigRefreshError = z.infer<typeof agentConfigRefreshErrorSchema>;
export type DependencyState = z.infer<typeof dependencyStateSchema>;
export type AuthStatusModelState = z.infer<typeof authStatusModelStateSchema>;
export type AuthLoginOutcome = z.infer<typeof authLoginOutcomeSchema>;
export type AuthLoginState = z.infer<typeof authLoginStateSchema>;
export type AuthPendingUrl = z.infer<typeof authPendingUrlSchema>;
export type AgentConfigEntry = z.infer<typeof agentConfigEntrySchema>;
export type AgentConfigList = z.infer<typeof agentConfigListSchema>;
export type AgentInstallPhase = z.infer<typeof agentInstallPhaseSchema>;
export type HostDependencyLedgerSnapshotDTO = z.infer<typeof hostDependencyLedgerSnapshotSchema>;
export type AgentInstallProgress = z.infer<typeof agentInstallProgressSchema>;

/**
 * 主进程递给 worker 的那**一本账**(#6101)。
 *
 * worker 进程够不到主进程的 KV,所以账不是它自己读出来的,而是属主递过来的一份副本 ——
 * 与 `runContext` 同一条路子(#5683):**要读的东西由知道答案的那一侧算好随请求给**,
 * ❌ 不在这边另起一套自己探。
 */
export const hostDependencyLedgerSnapshotSchema = z.object({
  ownedDirs: z.object({
    ownedNpmRoots: z.array(z.string()),
    ownedShimDirs: z.array(z.string()),
    ownedMiseBinDirs: z.array(z.string()),
  }),
  entries: z.array(
    z.object({
      id: z.string(),
      selection: hostDependencySelectionSchema,
      installRecord: z
        .object({
          method: z.enum(INSTALL_METHODS).optional(),
          registry: z.string().optional(),
          realpath: z.string(),
          version: z.string().nullable(),
        })
        .nullable(),
      lastCustom: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('path'), path: z.string() }),
          z.object({ kind: z.literal('cli'), command: z.string() }),
        ])
        .nullable()
        .optional(),
      probeEnv: z.record(z.string(), z.string()).optional(),
    })
  ),
});
