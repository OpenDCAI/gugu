/**
 * 「咕咕提供的模型」在会话页两侧(渲染层 composer / electron 主进程)之间的契约。
 *
 * 目录只由主进程取:模型清单是账号态与网关启用状态的函数,渲染层既够不到凭据也不该缓存它。
 * 倍率是 New API ratio(基线 1.0 == $2/M)的透传值,**只用于展示** —— 咕咕侧不维护第二套
 * 价格表,取不到就是 null,UI 省掉数字而不是猜一个,更不因此阻断目录或会话。
 */

/**
 * 渲染层 → 主进程的目录查询 channel(逻辑名 `sessionpagePlatformCatalog.list`)。
 * 入参 {@link PlatformModelCatalogRequest},返回 {@link PlatformModelCatalogResponse}。
 */
// ⚠️ 深路径,❌ 不走 `@gugu/core` 总入口:那个 barrel 会把 local/ 与 cloud/ 整棵 node 依赖树
// (node:fs / node:child_process / node:crypto …)拖进浏览器包,web 目标当场打不出来。
// `shared/agentModelSelection` 是纯模块,本来就是给渲染层与主进程共用的那一份。
import type { ModelAccessProtocol } from '@gugu/core/shared/agentModelSelection';

export const SESSIONPAGE_PLATFORM_CATALOG_CHANNEL = 'sessionpage-platform-catalog:list';

/**
 * 人点了重试(起任务页 / 私聊横幅的重试、「我开好了」、通用形态那一行的重试):这条会话下一次签咕咕额度真去问一次,
 * ❌ 拿取票退避窗口里的旧原因作答(#7103)。入参是会话 id;自动唤醒那几条路不走它,照旧被退避挡着。
 */
export const SESSIONPAGE_PLATFORM_RETRY_CHANNEL = 'sessionpage-platform:retry';

/**
 * 设置「模型」页开关了一条(#7056)⇒ 同一窗口里所有模型下拉重取目录。设置页与会话页是同一个 document
 * 里的两个 bundle(EmdashSessionFrame),`window` 事件两边都收得到;别的设备下次取目录时自然是新的。
 */
export const PLATFORM_MODELS_CHANGED_EVENT = 'gugu:platform-models-changed';

/**
 * 协议就是 core 那一份,**不在这里另写一个联合类型**。
 *
 * 从前这里抄了一份字面量联合,于是同一件事有三个真相:core 的 `ModelAccessProtocol`、
 * 这一行、以及 platform-model-catalog.ts 里那个 `PROTOCOLS` 运行时数组。2026-09-18 加
 * `openai-chat-completions` 时三处只改了一处就**编不过** —— 这次是运气好,它恰好在类型上撞了；
 * 而抄本更常见的下场是静默:新协议的模型被 `parseModel` 当脏数据丢掉,composer 里少几行,不报错。
 * ⇒ 别再抄,引用它。
 */
export type PlatformModelProtocol = ModelAccessProtocol;

/** 目录条目。edge fn catalog → electron → renderer 全链同一形状。 */
export interface PlatformModelOption {
  /** billing.platform_models.id,如 'glm-5.2'。 */
  id: string;
  displayName: string;
  /** 已按 providerId 选定,渲染层不再做协议判断。 */
  protocol: PlatformModelProtocol;
  /** New API ModelRatio 的相对倍率(如 0.7 / 2.5),display-only;取不到 = null。 */
  creditMultiplier: number | null;
  /**
   * `billing.platform_models.context_window`,tokens;取不到 = null。
   *
   * 目录端点本来就 select 了它、`model-access.ts` 也已经解析进目录条目 —— 只是从没往下递。
   * 于是咕咕的模型是这张下拉里**唯一没有能力说明的一档**:harness 自家模型经
   * `modelFeatures.contextWindowSize` 在行的 title 上写着 `Context 200K tokens`,
   * 咕咕的那十几条什么都没有 —— 而用户要在 ×0.1 与 ×5 之间挑,窗口大小正是他要比的东西之一。
   * (assistant-ui 那版 model picker 的「能力说明」对位物;矩阵 #82。)
   */
  contextWindow: number | null;
  /**
   * `billing.platform_models.reasoning_efforts`:这个模型认的推理档(#6447)。取不到 = null。
   *
   * 推理档是**每个模型**的事实,不是网关的:网关对 `reasoning.effort` / `output_config` 直通,上游各自校验
   * (glm-5.3 只认 low/high/max,claude-opus-5 到 max)。composer 能选的档 = harness 的清单 ∩ 这一组;
   * null / `[]` ⇒ 这个模型不画推理档(`resolveEffortCatalog`)。
   */
  reasoningEfforts: readonly string[] | null;
  /**
   * 目录的 `requires_membership`(#7056):网关在卖这个模型,但这个用户的会员档走不到它(免费档)。
   *
   * 门槛在网关(用户分组 = 会员档),这一格只决定**下拉里列不列它**(见 `offeredInModelPicker`)、
   * 设置「模型」页把它放进「升级解锁」那一组 —— 判错了也只是列错,不会放行。旧服务端不带这一项 ⇒ false。
   */
  requiresMembership: boolean;
  /** 目录的 `hidden`(#7056):他在设置「模型」页关掉了这一条。旧服务端不带这一项 ⇒ false。 */
  hidden: boolean;
}

/**
 * 这一条进不进模型下拉:他这一档用得了,而且没在设置「模型」页关掉(#7056,对齐 Cursor 的 Settings › Models)。
 *
 * ⚠️ 下拉里**只放点得中、跑得起来的**。从前把会员模型也列进来、点它去开通 —— owner 2026-10-10:「像是埋雷,
 * 让用户稍不留意就点到了他用不了的模型」。要会员的那些只在设置「模型」页出现,挂着升级解锁。
 * 新建默认预选、手机端、Agent 设置的运行模型都取这一个判据,❌ 各写一遍。
 */
export function offeredInModelPicker(model: { requiresMembership?: boolean; hidden?: boolean }): boolean {
  return !model.requiresMembership && !model.hidden;
}

/**
 * 目录 / 签发里的推理档字段(`reasoning_efforts`)→ `reasoningEfforts`。主进程解析服务端响应、渲染进程解析
 * IPC 都用这一份(#6447)。非空字符串数组原样(保序去重);`[]` 原样 —— 目录说这个模型没有这根轴;
 * 缺省或坏值一律 null —— 目录没有这条事实。❌ 坏值不当成 `[]`:那会把「不知道」说成「没有」。
 */
export function parsePlatformReasoningEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return null;
    if (!out.includes(entry.trim())) out.push(entry.trim());
  }
  return out;
}

export interface PlatformModelCatalogRequest {
  /** 会话页 provider id,如 'claude' / 'codex'。 */
  providerId: string;
  /**
   * 已存在的会话。带上它,主进程才解析得出 {@link PlatformModelCatalogResponse.agentDefault}
   * —— 新建会话时身份还没有,预选自然为空,那正是产品默认(纯 BYOK)。
   */
  sessionId?: string | null;
}

export interface PlatformModelCatalogResponse {
  models: PlatformModelOption[];
  /**
   * 该 provider 对应 agent 的 model_access 默认值,供下拉预选 —— agent 级配置退位为
   * 「composer 的预选默认值」,不再决定会话是否上平台。null = 没配;字段缺省 = 主进程
   * 这一版还没附带它(渲染层按 null 处理,不报错)。
   */
  agentDefault?: { modelId: string } | null;
  /**
   * The per-conversation composer decision, when one was recorded.
   * `null` is an explicit BYOK decision; an object is an explicit platform decision;
   * absent is a legacy/imported conversation without a composer decision.
   */
  sessionSelection?: { modelId: string } | null;
  /**
   * 目录取不到的**原因码**(session-core `guguCatalogReasonCode`,如 `gugu-models:unreachable`)。
   * 界面与 agent 工具面(`session_list_models` 的 `reason`)都只拿到码,各自按界面语言说人话;
   * 失败原文(服务端英文诊断、网络层 `net::ERR_…`)只进主进程日志(#6264 / #6478)。
   * ❌ 它不是阻断信号 —— harness 自家模型照常可选。
   */
  catalogError?: string | null;
}

/**
 * 会话创建载荷上的 per-session 选择。**三态,不是可选字段** —— 「没有这个决定」与「决定了走
 * harness」是两件事,合成一态就会把非 composer 的会话永久钉死在 BYOK 上:
 *
 * - **字段不存在**:这条创建路径上根本没有 composer 决策(自动化、spawn 出来的子会话、导入
 *   本机会话)。主进程**不落记录**,会话按 agent 级 model_access 解析 —— 与本改动之前一致,
 *   也是既有会话 respawn 时的回退口径。
 * - **null**:composer 上明确选了 harness 自家模型。主进程**记下这个 null**,这条会话此后
 *   永不注入平台环境,即使该 agent 的 model_access 配了平台模型。
 * - **{ modelId }**:选了平台模型,这条会话上平台 relay、按积分计费。
 *
 * 与会话类型无关:终端(pty)与 Chat UI(acp)会话都照这个决定跑,两条启动路径各自把凭据与
 * 模型注入进去 —— 有 composer 决策面的载荷就带上这个字段,没有的才缺席。
 */
export type SessionPlatformModel = { modelId: string } | null;
