import { defineContract, eventStream, procedure } from '@gugu/session-wire';
import { z } from 'zod';
import { agentRunContextSchema } from '../../agents/agent-run-context';
import { acpStartInputSchema, queuePromptCommandSchema } from './commands';
import { promptInputSchema } from '../models/prompt';
import { sessionNoticeCodeSchema, transcriptTurnSchema } from '../models/turns';
import { acpApiContract } from './contract';

/**
 * Process-level platform credentials for an ACP adapter.
 *
 * This schema belongs to the private main<->worker contract. It is deliberately absent from
 * acpApiContract/acpStartInputSchema, so renderer input can never carry or observe a relay token.
 */
export const acpPlatformInjectionSchema = z.object({
  model: z.string().min(1),
  providerId: z.string().min(1),
  providerLabel: z.string().min(1),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  authRequest: z.record(z.string(), z.unknown()).optional(),
  spawnEnv: z.record(z.string(), z.string()),
  /**
   * The platform model's real context window in tokens; absent when unknown.
   *
   * Declared here because this schema is the boundary the payload is parsed at, and zod strips
   * keys it was not told about — an adapter that reads a field nobody declared reads undefined,
   * with nothing logged and nothing thrown.
   */
  contextWindow: z.number().int().positive().optional(),
  /**
   * 这个平台模型认的推理档(目录 `billing.platform_models.reasoning_efforts`,#6447);缺席 = 目录没有。
   * 与 `contextWindow` 同一条理由声明在这里:zod 会静默丢掉没声明的键。
   */
  reasoningEfforts: z.array(z.string().min(1)).nullable().optional(),
  /**
   * 这条会话中途还能**热切**到的模型(这条协议下的全部平台模型,与令牌白名单是同一组)。
   *
   * 适配器照它 advertise 模型清单 —— 三家 harness 都只在启动那一刻收得到清单,spawn 之后
   * 学不到新端点/凭据,所以「能换哪些」必须随这份载荷一起到达。缺席 = 只有 `model` 一个。
   *
   * ⚠️ 与 `contextWindow` 同一条理由:zod 会静默丢掉没声明的键,所以字段加在组装侧还不够。
   */
  switchableModels: z.array(z.object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    contextWindow: z.number().int().positive().nullable().optional(),
    reasoningEfforts: z.array(z.string().min(1)).nullable().optional(),
  })).optional(),
  /**
   * 签发响应的 `callable_routes`(#6921):网关路由原文 → 这枚令牌在那条路由上能调的模型。
   * 适配器据此决定开不开 harness 自己的内置工具(codex 出图)。缺席 = 老服务端 = 没有。
   * ⚠️ 与 `contextWindow` 同一条理由:zod 会静默丢掉没声明的键。
   */
  callableRoutes: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
});
export type AcpPlatformInjection = z.infer<typeof acpPlatformInjectionSchema>;

// 「跑哪一份 CLI」的宿主答案住在 agents 层(ACP 与 agent-config 两条 worker 合同共用),这里只转出。
export { agentRunContextKey, agentRunContextSchema, type AgentRunContext } from '../../agents/agent-run-context';

export const acpRuntimeStartInputSchema = acpStartInputSchema.extend({
  /** Host-owned executable resolution (#5681); never accepted from the renderer contract. */
  runContext: agentRunContextSchema,
  /** Host-resolved source facts for a provider-specific runtime fork. */
  forkSourceSession: z.object({
    id: z.string(),
    title: z.string(),
    providerId: z.string(),
    providerSessionEndpoint: z.string().url().optional(),
  }).optional(),
  platform: acpPlatformInjectionSchema.optional(),
  /**
   * 这次启动**钉的那个平台模型**(咕咕规范 id),由宿主按会话记录给出;不走平台额度时缺席。
   *
   * 它与上面 `platform` 不是一回事:`platform` 是 codex 那一族的进程级凭据载荷,别的家的平台模型
   * 骑在能力包 / `_meta` / 进程环境里,runtime 看不见。而重开之后要断言的是**模型**本身 ——
   * pi / copilot 恢复会话时回到自己会话记忆里的模型,spawn 钉的不算数(#6196)——
   * 所以每一家都要把这一格交到 runtime,由 `session-manager.applyInitialModel` 断言。
   */
  platformModel: z.string().min(1).optional(),
  /** Host-owned platform access generation; never accepted from the renderer contract. */
  platformAccessSessionId: z.string().min(1).optional(),
  capabilitySpawnEnv: z.record(z.string(), z.string()).optional(),
  /** Host-owned provider arguments emitted by the session capability materializer. */
  capabilitySpawnArgs: z.array(z.string()).optional(),
  /**
   * #7223 建来常驻、一句还没聊过的 agent(宿主按会话记录判:没有已提交回合、也没有首轮;只由宿主给出)。
   * 续接 `providerSessionId` 时引擎说没有这条 ⇒ 同一次启动里照现有降级改走 `session/new`:同一个引擎、
   * 同一张平台票、启动途中排进来的话都还在。❌ 报 provider_session_missing 让它每次唤醒都失败。
   * 缺席 = 聊过、或记着首轮(首轮没跑完的照旧由用户点「重来」照首轮重来):引擎说没有就如实报 missing。
   */
  freshIfProviderSessionMissing: z.boolean().optional(),
});
export type AcpRuntimeStartInput = z.infer<typeof acpRuntimeStartInputSchema>;

const detachedPromptInputSchema = z.object({
  sessionId: z.string(),
  prompt: promptInputSchema,
  steerIfBusy: z.boolean().optional(),
});
const detachedPromptResponseSchema = z.object({
  requestId: z.string(),
  queued: z.boolean(),
  /** #6387 插进了在飞的那一轮(而不是开了新的一轮)。 */
  steered: z.boolean().optional(),
  declined: z.boolean(),
  missing: z.literal(true).optional(),
});
const detachedPromptWaitInputSchema = z.object({ requestId: z.string() });

/** Internal ACP process contract. The Electron renderer is exposed acpApiContract, never this one. */
export const acpRuntimeApiContract = defineContract({
  ...acpApiContract,
  startSession: procedure({
    input: z.object({ input: acpRuntimeStartInputSchema }),
    output: acpApiContract.startSession.output,
  }),
  resumeSession: procedure({
    input: z.object({ input: acpRuntimeStartInputSchema.extend({ providerSessionId: z.string() }) }),
    output: acpApiContract.resumeSession.output,
  }),
  /**
   * 启动还在路上时排队的那一句会带着 `startInput`;会话还不存在时 worker 就用它**直接起**会话。
   * ⇒ 它也是一个 start 边界:宿主必须交给 worker 与 `startSession` **同一份**注入完的输入
   *   (会话事实、能力、平台凭据、`runContext`,#5681/#5233),❌ 让它走 renderer 那份输入。
   */
  queuePrompt: procedure({
    input: queuePromptCommandSchema.extend({ startInput: acpRuntimeStartInputSchema.optional() }),
    output: acpApiContract.queuePrompt.output,
  }),
  platformSessionClosed: eventStream({
    key: z.void(),
    event: z.object({
      sessionId: z.string(),
      platformAccessSessionId: z.string().min(1).optional(),
    }),
  }),
  /**
   * 一条回合提交了(#5381)。主进程订阅它把历史落盘 —— 会话页不再把「用户会不会丢历史」
   * 交给 provider 的重放去决定(实测:claude 的适配器在上下文压缩之后只重放最后一次压缩边界
   * 之后的部分)。**只在私有合同里**:渲染进程读历史走库,不需要也不该看见这条推送。
   *
   * `source` 区分这一回合是**刚发生的**还是**重放回来的**。两者的处置不同,而且判断只能在
   * 主进程做——运行时不知道库里有没有这条会话的历史:
   *   - `live`   → 直接落盘。
   *   - `replay` → 只有当这条会话在库里一行都没有时才落盘(为本改动之前就存在的老会话做一次回填)。
   *     否则丢弃:库里那份才是完整的,重放只含压缩边界之后的一段,落进去就是把同一句话写两遍。
   */
  turnCommitted: eventStream({
    key: z.void(),
    event: z.object({
      sessionId: z.string().min(1),
      /** 跑这条会话的 harness —— 主进程据此维护「这家登录已失效」(#6264)。 */
      providerId: z.string().min(1).optional(),
      /**
       * 这条会话跑的是咕咕平台模型(宿主签了平台凭据)—— 那时成败说明的是平台,不是用户自己那份登录,
       * 「登录已失效」❌ 据此增减(#6264)。
       */
      platformCredentials: z.boolean().optional(),
      /**
       * `revision` = 最后一轮改口(结局或迟到的尾巴);`backfill` = **更早**的一轮被迟到的事件就地补了内容
       * (后台命令的终态回填到起它的那一轮,#6582)—— 它说的是过去,之后已经有别的轮了。
       */
      source: z.enum(['live', 'replay', 'revision', 'backfill']),
      turn: transcriptTurnSchema,
    }),
  }),
  /** 主进程保存回退后的显示历史,再放开这条会话的发送。 */
  finishHistoryRevert: procedure({
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.void(),
  }),
  /**
   * 这条会话此刻attach的适配器进程 —— 连接 key + pid。**只在私有合同里**:渲染进程不需要、
   * 也不该看见进程身份。会话重载拿它当「进程真的换了没有」的判据(见 SessionManager 的同名方法)。
   */
  adapterProvenance: procedure({
    input: z.object({ sessionId: z.string().min(1) }),
    output: z.object({
      connectionKey: z.string(),
      pid: z.number().int().nullable(),
      closing: z.literal(true).optional(),
    }).nullable(),
  }),
  /**
   * #6396 宿主告诉一条活会话一件事:转录里画一行(`notice`,给人看,❌ 进 agent 的上下文)。
   * **只在私有合同里**:这是宿主的事实,渲染进程不发起它。会话不在这个 worker 里 ⇒ `delivered: false`。
   * #6490 这里曾经还有一格「挂到 agent 下一轮开头的一段话」,用来推改名后的身份块 —— 可变事实走一次性推送,
   * 推不到终端会话、进程一重启就丢。名字现在不进 agent 的上下文(要知道就调 profile_whoami),那一格没有调用方了,删掉。
   */
  announceSession: procedure({
    input: z.object({
      sessionId: z.string().min(1),
      notice: z.object({
        code: sessionNoticeCodeSchema,
        detail: z.string(),
        effectiveValue: z.string().optional(),
        previousValue: z.string().optional(),
      }).optional(),
      /** #6387 扩展的「附带」:随下一轮进去、进转录;同键替换(见 SessionCell.setTurnContext)。 */
      turnContext: z.object({ key: z.string().min(1), text: z.string().min(1) }).optional(),
      /**
       * #7103 这一轮来要票、咕咕没签出来:原因码(`gugu-models:<原因>`),宿主在回绝取票**之前**递;
       * 同一轮里后来签出来了递 null 撤掉。见 SessionCell.noteCredentialRefusal。
       */
      credentialRefusal: z.string().min(1).nullable().optional(),
    }),
    output: z.object({ delivered: z.boolean() }),
  }),
  promptDetached: procedure({
    input: detachedPromptInputSchema,
    output: detachedPromptResponseSchema,
  }),
  waitPromptDetached: procedure({
    input: detachedPromptWaitInputSchema,
    output: z.object({ queued: z.boolean() }),
  }),
});

export type AcpRuntimeApiContract = typeof acpRuntimeApiContract;
