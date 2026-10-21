import type { ModelConfigDialect } from './session-bundle'

/**
 * 平台额度(咕咕的模型)要怎么送进这一家 —— **这一家自己声明**,宿主只读声明。
 *
 * 从前这些事实散在三处:core 的 `ENGINE_WIRE_PROTOCOL`(协议)、桌面 `engine-injection-contract.ts`
 * 的 `CONTRACTS`(每个界面一格的进程拓扑)、`engine-dimension-completeness.ts`(编译期对账前两者)。
 * 现在一家一份,写在 `impl/<家>/platform.ts`(纯数据、浏览器安全:渲染层要按 agent 类型查协议)。
 *
 * 字段是必答的:没接平台模型的家给 `{ kind: 'unsupported', reason }`,❌ 不许缺席。
 */

/**
 * 用户面对的是哪一个界面。
 *
 * `tui` = 会话页的终端会话(pty 里跑 harness 本体),`cui` = Chat UI(ACP 会话)。
 * 按 (家, 界面) 声明而不是只按家:同一个引擎两个界面的进程拓扑不同(见桌面 `engine-injection-contract.ts` 抬头)。
 */
export type InjectionSurface = 'tui' | 'cui'

/**
 * 凭据最终要落进哪个进程。
 *
 * - `visibleClient`:用户盯着的那个进程本身就在跟模型说话(claude TUI)。
 * - `detachedInference`:推理跑在另一个长命进程里,可见进程只是它的客户端(codex 的 app-server、
 *   opencode 的 serve)。
 * - `acpAdapter`:经 ACP 适配器进程转交 —— 每条 ACP conversation 都拥有独立 adapter；Claude
 *   的凭据经 `_meta` 寻址到会话，Codex/OpenCode 的平台凭据进入进程环境。
 */
export type InjectionProcess = 'visibleClient' | 'detachedInference' | 'acpAdapter'

/**
 * 凭据以什么载体送进那个进程。载体决定了**安全边界**,所以它必须显式声明而不是「反正传进去就行」:
 *
 * - `processEnv`:spawn 时的进程环境。凭据的默认归宿(进程环境不像 argv 那样人人可读)。
 * - `settingsDocumentFile`:一个 0600 的会话级 settings 文档,**传路径**。claude 专用:用户
 *   `~/.claude/settings.json` 里的 `env` 块在启动时会被写进进程环境,压过我们 spawn 前导出的一切,
 *   只有 `--settings` 那一层压得住它。❌ 绝不内联 JSON —— 那会把中转令牌写进命令行,而 argv 在进程表
 *   里人人可读(Agent SDK 把 `options.settings` 直接拼成 `--settings <值>`,实测确认)。
 * - `providerConfigArgs`:写进 argv 的 provider 声明(codex 的 `-c model_providers.*`)。**只放地址,
 *   不放令牌** —— 令牌由 `env_key` 指名的环境变量携带。
 * - `spawnEnvConfigDocument`:整份配置文档塞进一个环境变量(opencode 的 `OPENCODE_CONFIG_CONTENT`)。
 * - `acpSessionMeta`:ACP `session/new` | `session/load` 的 `_meta`,按会话寻址。
 */
export type CredentialCarrier =
  | 'processEnv'
  | 'settingsDocumentFile'
  | 'providerConfigArgs'
  | 'spawnEnvConfigDocument'
  | 'acpSessionMeta'

/** 一条「凭据要落到哪个进程、用什么载体」。 */
export interface CredentialSink {
  process: InjectionProcess
  carrier: CredentialCarrier
}

/**
 * 令牌的有效期**绑在什么东西的存活上** —— 也就是「谁死了,这个令牌就该被结算撤销」。
 *
 * - `visibleClient`:绑可见进程。它重启 = 新进程 = 必须签新令牌。
 * - `detachedInference`:绑那个独立推理进程(codex app-server、opencode serve)。它还活着就**必须复用**已签发的令牌,
 *   重新签发会先撤销活进程手里那个 → 此后每轮 401(台账 3 号)。
 * - `acpSession`:绑一条 ACP 会话。claude Chat UI 是这一档:凭据按会话经 `_meta` 送达,会话 stop /
 *   记录移除 / 运行时进程销毁时释放。
 * - `acpAdapterProcess`:绑适配器进程本身(凭据在它 spawn 时进的环境,同 `detachedInference` 的
 *   复用语义)。codex / opencode 的平台 Chat UI 适配器按 conversation 私有。
 */
export type TokenLifetime =
  | 'visibleClient'
  | 'detachedInference'
  | 'acpSession'
  | 'acpAdapterProcess'

/**
 * 重开一条会话时,凭什么判断「上一个令牌还有活的消费者、不能重签」。
 *
 * - `none`:从不复用(可见进程档:重开就是新进程)。
 * - `liveInferenceProcess`:去问那个推理/适配器进程还在不在。
 * - `heldRecord`:我们自己还留着这条会话的签发记录就算活着 —— 记录的消失由会话结束路径负责,
 *   所以「记录还在」正是「还没结束」。
 */
export type TokenReuseProbe = 'none' | 'liveInferenceProcess' | 'heldRecord'

/**
 * 这个 harness 会自己点名几种模型。
 *
 * `main` = 用户那一轮对话本身。`backgroundUtility` = harness **自作主张**发起的小请求(Claude Code 的
 * 会话标题 / 命令描述,它内置打 Haiku 档)。平台令牌在网关上只白名单一个模型,所以每一个声明了的槽位
 * 都必须被显式钉到指定模型上,否则那一档请求会 403 —— 而它不是用户发的,用户只会看到终端里蹦出一段
 * 裸报错(台账 1 号)。
 */
export type ModelSlot = 'main' | 'backgroundUtility'

/**
 * 线上真正发出去的那个 HTTP 形状。与 core 的 `ModelAccessProtocol` 是同一组词 ——
 * core 看不见插件、插件看不见 core,桌面 `engine-injection-contract.ts` 里有编译期断言钉住两边逐字相同。
 */
export type HarnessWireProtocol =
  | 'anthropic-messages'
  | 'openai-responses'
  | 'openai-chat-completions'
  | 'gemini-generate-content'

/**
 * 一个界面上的注入拓扑(从前 `CONTRACTS` 的一行,去掉引擎 id 与方言)。
 *
 * ⚠️ 只跑 ACP 适配器的家(cui 格,没有 codex 那种独立推理进程),凭据在适配器 spawn 时进入,一律写
 *    `tokenLifetime: 'acpAdapterProcess'` + `tokenReuseProbe: 'heldRecord'`。❌ `liveInferenceProcess`:
 *    注入器那一格的 `inferenceProcessLive` 是写死的 false(适配器池没有可问的进程探针),它会恒假成
 *    「每次重签」,而重签会撤销活适配器手里那张票。判据在 `platform-adapter-env.test.ts`。
 */
export interface PlatformSurfaceInjection {
  credentialSinks: readonly CredentialSink[]
  tokenLifetime: TokenLifetime
  tokenReuseProbe: TokenReuseProbe
  modelSlots: readonly ModelSlot[]
  /**
   * 这一格的注入是否**已经接线**。
   *
   * `false` = 表上有位置、代码还没接。平台路径撞到它必须响亮失败:静默跑下去就是「composer 上写着咕咕的
   * 模型、实际花用户自己的 Key」,正是这套设计要杜绝的那种失败。
   */
  wired: boolean
}

export type HarnessPlatform =
  | {
      kind: 'supported'
      /** 每一行后面的注释就是它的出处,❌ 不许凭「它读 OPENAI_API_KEY」猜。 */
      wireProtocol: HarnessWireProtocol
      /** 这一家接受模型指定的方言。方言是引擎级属性,界面只决定投递到哪个进程。 */
      dialect: ModelConfigDialect
      injection: Partial<Record<InjectionSurface, PlatformSurfaceInjection>>
    }
  | { kind: 'unsupported'; reason: string }

/** 还没为这一家接平台模型。有具体原因的家写自己的 `reason`。 */
export const PLATFORM_NOT_WIRED: HarnessPlatform = {
  kind: 'unsupported',
  reason: '咕咕尚未为这一家接平台模型(没有协议登记,也没有注入拓扑)'
}
