/**
 * 引擎的**支持档** —— owner 2026-08-24 定：
 *
 *   「不覆盖的 agent 我们先设定为不支持吧，逐步覆盖吧，**不支持的 agent 也不给用户用的空间了**。
 *     还有支持的 harness，需要做到和 claude code codex 级别的支持，……比如调通 gugu model 用这些
 *     harness，再比如用 plugin。」
 *
 * ## ⚠️ 第一版这三条**全都量错了字段**，读这段再改
 *
 * 第一版写的是 `acp` + `sessionBundle.units.model` + `sessionBundle.extension`，量出 3 家。
 * 三条里有两条量的是**咕咕自家 bundle 的静态声明**，而不是产品真正在跑的机制：
 *
 *  · **模型**：产品对 ACP 家是**问 harness 自己**要目录
 *    (`initial-session-section.tsx` 的 `useModelOptions` 取 ACP `session/new` 的
 *     `configOptions[category=model]`，注释原文「❌ 不再读插件里那张静态表」——因为那张表实测是错的)；
 *    回传也是通用的 (`acp-agents/session/cell.ts` 的 `ConfigDimension = 'model' | 'effort'`，
 *     configId 直接取 harness 报的那个)。拉目录那一侧同样通用
 *    (`harness-model-catalog-wiring.ts`，闸就是 `capabilities.acp.kind === 'supported'`)。
 *    ⇒ 一家只要说 ACP，模型这条**今天就是通的**；`units.model` 那张静态表只在「不说 ACP」时才用。
 *
 *  · **插件**：`sessionBundle.extension` 是**咕咕自家的扩展包格式**(declarative-bundle /
 *    event-module)，全仓只有 4 家。而用户说的「用 plugin」，实际机制是 **MCP** ——
 *    `capabilities.mcp` 那个适配器负责把 MCP server 写进这家引擎自己的配置，13 家有。
 *
 * ⇒ 按真机制重算是 **10 家**，不是 3 家。差别不是口径松紧，是第一版**根本没量到产品在用的东西**。
 * ❌ 别再拿 `sessionBundle.*` 的声明当「能力」——那一层记的是咕咕打包时的形态，
 *    不是运行时走哪条路。（同一个坑本轮踩了两次，见 PR 里的记录。）
 *
 * ## 三条判据（缺一不可）
 *
 *  1. `acp.kind === 'supported'`  —— 会话真跑得起来：结构化往返，不是只有一条 TUI 腿。
 *  2. 模型：`acp` 通用路径 **或** `units.model.kind === 'native'`（非 ACP 家的静态推送）。
 *  3. `mcp.kind === 'supported'` —— **plugin 装得进去**（MCP server 写得进这家的配置）。
 *
 * ## ❌ 为什么不是一张手写名单
 *
 * 手写名单会漂：某家的 MCP 适配器哪天被摘掉，名单还在，界面继续把它当支持的卖给用户。
 * 这里从 capabilities **推导** ⇒「能力退化」与「掉出支持档」是同一件事，不可能只发生一半。
 *
 * ## ⚠️ 挡的是「新建的入口」，不是「查表」
 *
 * 这条线只过滤**提供给用户挑选/安装的列表**（`listPlugins()`）。`getPlugin(id)` 照常解析所有
 * 已注册的家 —— 否则一个已经在用 gemini 的用户，会话会当场解析不到 provider 而炸。
 * ❌ 别把这条线接到 `pluginRegistry.get()` 上。
 */

// ⚠️ 这一条 import 与下面那句「不 import 具体的 capabilities 类型」**不冲突**：
//    禁的是引 zod 推导出来的 capabilities 类型（那条链经 `plugins/index.ts` 会成环）。
//    `session-bundle.ts` 不引本模块（已核，0 处），这里引的又只是一个纯函数，不成环。
import { unitDeliveryIsNativeEverywhere } from './session-bundle'

/**
 * ⚠️ 结构化入参，**不 import 具体的 capabilities 类型**：
 *  · capabilities 是 zod 推导出来的，没有一个可引的具名类型；
 *  · 这个模块被 `plugins/index.ts` 那条链消费，反向 import 会成环。
 * 只读四个字段，读错了对账用例会红（它拿真 registry 逐家核，并反向钉住每条闸今天确实在卡人）。
 *
 * ⚠️ `units.*` 这几格现在也可能是 `{kind:'per-surface', surfaces:{…}}`（按腿分别声明），
 *    所以判 native 一律经 `unitDeliveryIsNativeEverywhere`，❌ 别写 `.kind === 'native'`。
 */
export interface SupportProbeInput {
  acp?: { kind?: string }
  mcp?: { kind?: string }
  autoApprove?: { kind?: string; modes?: Readonly<Record<string, unknown>> }
  sessionBundle?: {
    /** 这一家声明了哪几条腿 —— 集成档是**按腿**算的，见 `probeGuguIntegration`。 */
    surfaces?: readonly string[]
    units?: {
      mcp?: { kind?: string }
      env?: { kind?: string }
      model?: { kind?: string }
      autonomy?: { kind?: string }
      promptBlocks?: { kind?: string }
    }
  }
}

export type AgentSupportTier = 'supported' | 'unsupported'

/** 判据逐条的读数，红了要能一眼看出缺哪一条，别只给一个 boolean。 */
export interface AgentSupportProbe {
  tier: AgentSupportTier
  acp: boolean
  model: boolean
  mcp: boolean
}

export function probeAgentSupport(capabilities: SupportProbeInput): AgentSupportProbe {
  const acp = capabilities.acp?.kind === 'supported'
  // ACP 家走通用运行时路径(目录 + set_config_option 回传);其余家才看静态推送声明。
  const model = acp || unitDeliveryIsNativeEverywhere(capabilities.sessionBundle?.units?.model)
  const mcp = capabilities.mcp?.kind === 'supported'
  return { tier: acp && model && mcp ? 'supported' : 'unsupported', acp, model, mcp }
}

export function agentSupportTier(capabilities: SupportProbeInput): AgentSupportTier {
  return probeAgentSupport(capabilities).tier
}

/**
 * **咕咕集成档** —— owner 2026-08-25 定的上线切口。
 *
 * 原话：「我这个 PR 如果保持目前 p1 的适配，基本不可能说有合的日期……其他的**如果已经完全适配
 * 的就加，如果没有适配的就先完全不加**。」
 *
 * ## 它和上面那个支持档问的**不是同一个问题**
 *
 * 上面那三条问的是「**用户能不能驱动这家**」：会话跑得起来、能挑**它自己的**模型、装得进 MCP。
 * 那个判据今天仍然成立，❌ 别去改它 —— 也别把这里的 `units.*` 塞进那边（本模块开头记着那个坑：
 * `sessionBundle.*` 记的是咕咕打包时的形态，不是产品运行时走哪条路，拿它量 harness 自身的能力
 * 已经错过两次）。
 *
 * 这里问的是另一件事：「**咕咕自己的那套东西，在这家上都投递到了吗**」——平台模型、
 * 权限档、身份自述、咕咕的 MCP server。对**这个**问题，`units.*` 恰恰是正确的记录：
 * 它记的就是咕咕的会话包在这家上真的物化出了什么。
 *
 * ## 五条
 *
 *  1. `units.mcp`         —— 咕咕的 MCP server 送得进去（agent 才发得出消息）
 *  2. `units.env`         —— 会话环境交得出去
 *  3. `units.model`       —— **咕咕的平台模型**注得进去（不是「它自己有模型」）
 *  4. `units.promptBlocks` —— 身份自述进得了系统提示（agent 才知道自己是谁）
 *  5. 权限档 —— `units.autonomy` 是 native，**或** `autoApprove.modes` 有档位映射表。
 *     两条都算，因为这一维本来就有两条落地路：会话包在 spawn 时物化（opencode 系写
 *     `permission`、qwen/copilot 走 argv），或 ACP 自报档位 + `session/set_mode`（claude 走这条，
 *     它的 `units.autonomy` 是 none 但四档全有）。❌ 只认前一条会把 claude 判成没接。
 *
 * ## ❌ 同样不是一张手写名单
 *
 * 理由与上面那条一样：手写名单会漂 —— 某家的某一维哪天退化了，名单还在，界面继续把它
 * 当「完全适配」卖给用户。从 capabilities 推导 ⇒「能力退化」与「掉出这一档」是同一件事。
 */
export interface GuguIntegrationProbe {
  integrated: boolean
  mcp: boolean
  env: boolean
  model: boolean
  promptBlocks: boolean
  autonomy: boolean
}

/**
 * 这一格在**某一条腿**上是不是 native。
 *
 * ⚠️ 按腿声明里缺这条腿 = 作者漏写。这里读成 false(而不是抛)——探针是**只读**的，
 *    一个漏写不该让整张列表炸掉；真正 fail loud 的地方是物化(`resolveUnitDelivery`)。
 */
function nativeOn(unit: unknown, surface: string): boolean {
  const u = unit as { kind?: string; surfaces?: Record<string, { kind?: string }> } | undefined
  if (u?.kind === 'native') return true
  if (u?.kind !== 'per-surface') return false
  return u.surfaces?.[surface]?.kind === 'native'
}

/**
 * 咕咕集成档 —— **按腿算，取最好的那条腿**。
 *
 * ## ❌ 为什么不是「每条腿都通」
 *
 * 一家可以「协议腿五维全通、终端腿缺一维」。要求每条腿都通，就会因为弱的那条腿把**已经
 * 完整可用的**那条腿一起藏掉 —— 用户在选择器里看不到一个明明能用的引擎。
 * （owner 2026-08-27：「被筛掉了更不对啊」。）
 *
 * ## ❌ 为什么也不是「单维层面的 some」
 *
 * 那更糟:A 腿的 mcp + B 腿的 promptBlocks 拼出一个「五维齐全」，而**没有任何一条腿真的
 * 能用**。那是让强的腿替弱的腿背书，behavior `agent-config-boundary` 明令禁止。
 *
 * ⇒ 正确的问法是**存在一条腿，它自己的五维全通**。逐条腿算完再取，❌ 不许跨腿拼。
 */
export function probeGuguIntegration(capabilities: SupportProbeInput): GuguIntegrationProbe {
  const bundle = capabilities.sessionBundle
  const units = bundle?.units
  // 档位映射表非空才算 —— `autoApprove: { kind: 'supported' }` 单独存在时它只表示
  // 「TUI 那条腿有个全自动 flag」，不构成分级。这一条与腿无关，两条腿共用。
  const autoApproveLadder =
    capabilities.autoApprove?.kind === 'supported'
    && Object.keys(capabilities.autoApprove.modes ?? {}).length > 0

  const onSurface = (surface: string): GuguIntegrationProbe => {
    const mcp = nativeOn(units?.mcp, surface)
    const env = nativeOn(units?.env, surface)
    const model = nativeOn(units?.model, surface)
    const promptBlocks = nativeOn(units?.promptBlocks, surface)
    const autonomy = nativeOn(units?.autonomy, surface) || autoApproveLadder
    return {
      integrated: mcp && env && model && promptBlocks && autonomy,
      mcp,
      env,
      model,
      promptBlocks,
      autonomy,
    }
  }

  const surfaces = bundle?.surfaces ?? []
  const readings = surfaces.map(onSurface)
  // 取第一条**自己**五维全通的腿;都不通就报第一条腿的读数(它说得出缺哪一维)。
  return (
    readings.find((r) => r.integrated)
    ?? readings[0]
    ?? { integrated: false, mcp: false, env: false, model: false, promptBlocks: false, autonomy: false }
  )
}

/**
 * 兜底开关 —— **默认关**，与 owner 的「不给用户用的空间」一致。
 *
 * 留它的理由只有两条，都不是「给产品留后路」：
 *  · 开发/取证要在界面上驱动一家还没达标的引擎；
 *  · 用户升级后发现自己在用的那家没了，得有一条**文档化的**恢复路径，而不是只能回滚版本。
 * ❌ 别在产品代码里读它做别的分支；它只决定「列不列出来」这一件事。
 */
export const SHOW_UNSUPPORTED_AGENTS_ENV = 'GUGU_SHOW_UNSUPPORTED_AGENTS'

export function shouldOfferUnsupportedAgents(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHOW_UNSUPPORTED_AGENTS_ENV] === '1'
}
