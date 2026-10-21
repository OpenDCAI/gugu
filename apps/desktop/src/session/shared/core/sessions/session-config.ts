import z from 'zod';
import { GUGU_PERMISSION_MODES, promptInputSchema, providerSessionStateSchema } from '@gugu/session-core/acp/client';
import { defineVersionedSchema } from '@shared/lib/versioned-schema/versioned-schema';

const sessionConfigV0Schema = z.object({
  permissionMode: z.enum(GUGU_PERMISSION_MODES).optional(),
  /** @deprecated Moved to sessions.provider_session_id column; stripped on upgrade to v1. */
  providerSessionId: z.string().optional(),
  initialPrompt: z.string().optional(),
  /** Model to pass to the agent CLI (e.g. 'claude-sonnet-5', 'o4-mini'). Empty string or absent = CLI default. */
  model: z.string().optional(),
});

const initialQueuePromptSchema = z.object({
  text: z.string(),
  hiddenContext: z.string().optional(),
  // Absent only on text stored without one (rows from before #6823, 「重来」's replay); the row reader fills it.
  origin: promptInputSchema.shape.origin,
});

const sessionMessageSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  kind: z.enum(['ordinary', 'session-direct']).optional(),
  state: z.enum(['pending', 'dispatching']).optional(),
});

const spawnStartupStateSchema = z.enum(['starting', 'ready']);

/**
 * 由**另一台机器**上的会话派出来的(agent 的 session_* 跨机器,owner 2026-09-30 拍板)。
 * `parent_session_id` / `spawned_by_session_id` 是本机库的外键,装不下别的机器上的会话,所以记在这里;
 * 它只记来历;挂在谁下面记在 `parentRemote`。`nested`(= 挂在派它的会话下面)是 parentRemote 之前的写法,只剩读。
 */
const spawnedByRemoteSchema = z.object({
  deviceId: z.string().min(1),
  sessionId: z.string().min(1),
  agentUserId: z.string().optional(),
  name: z.string().optional(),
  nested: z.boolean().optional(),
});

/** 父会话在别的机器上(本机外键装不下):spawn 的 nest 或 session_set_parent 写下。与 `parent_session_id` 只有一格有值。 */
const parentRemoteSchema = z.object({
  deviceId: z.string().min(1),
  sessionId: z.string().min(1),
});

/**
 * `sessions.title` 是谁定的 —— 优先级:显式命名 > 自动起的名 > 首轮兜底。
 * - 缺席 = 首轮推出来的兜底(或 provider 计数),自动起的名可以盖掉它;
 * - 自动起的名有两个来源,**先到先得、只起一次**(#7337):
 *   - `harness` = harness 自己起的名(ACP `session_info_update`、TUI 落盘的标题记录),harness 再改名照样跟;
 *   - `generated` = 咕咕拿首轮找平台模型起的名;落下之后 harness 起的名 ❌ 再盖它,反之咕咕也不再起。
 * - `manual` = 人或 agent 显式命名的(侧栏/手机改名、`session_spawn` 的 title、harness 里的 `/rename`、
 *   分叉名),自动起的名 ❌ 再也盖不掉它。
 * 标题这一列本身分不出这几种(同形),所以来历单记一格。Additive optional,两种形态口径一致。
 *
 * 这一格出现之前落库的会话没有它:标题正好是咕咕自己推出来的兜底形状才算兜底,别的一律按显式命名
 * (那时 `session_spawn` 的 title、侧栏改过的名、分叉名都长在同一列里)。
 */
export const sessionTitleSourceSchema = z.enum(['manual', 'harness', 'generated']);
export type SessionTitleSource = z.infer<typeof sessionTitleSourceSchema>;

/**
 * #7342 引擎**最后一次**报的上下文读数,进程停了也留着 —— 输入框停下后照旧画得出那个圈。
 * 一份读数只属于「一条原生会话 × 一个模型」,两样都记下,对不上就不是它的(❌ 拿旧的冒充现在的):
 * - `modelId` = 量它时会话自报的模型(活会话 `currentModelId` 那个 id)—— 上限随模型变;
 * - `providerSessionId` = 量它时那条原生会话 —— 「重来」、换计费路换掉原生会话后上下文从零开始。
 * 只由会话所在那台机器的 ACP 状态桥写,一轮落定才写。
 */
export const sessionContextUsageSchema = z.object({
  used: z.number().int(),
  size: z.number().int(),
  modelId: z.string().nullable(),
  providerSessionId: z.string().min(1),
});
export type SessionContextUsage = z.infer<typeof sessionContextUsageSchema>;

/** 这份读数是不是记录**此刻**那条原生会话的(读者与写者同一条判据)。 */
export function contextUsageBelongsTo(
  usage: SessionContextUsage,
  providerSessionId: string | null | undefined
): boolean {
  return !!providerSessionId && usage.providerSessionId === providerSessionId;
}

const pendingRestartSchema = z.object({
  status: z.literal('restart_failed'),
  dimension: z.enum(['model', 'permission', 'effort', 'mcp']),
  targetModel: z.string().optional(),
  targetModelSource: z.enum(['platform', 'own']).optional(),
  error: z.string().min(1),
});

export const sessionLibraryMcpFactSchema = z.object({
  delivered: z.array(z.string()),
  leftOut: z.array(
    z.object({
      name: z.string(),
      reason: z.enum(['shadowed', 'missing', 'no-channel', 'no-stdio', 'collides']),
      /** `collides`:撞了咕咕自己的哪一台。 */
      with: z.string().optional(),
    })
  ),
});

export type SessionLibraryMcpFact = z.infer<typeof sessionLibraryMcpFactSchema>;

const ptyConfigV1 = z.object({
  subscriptionConnectionId: z.string().optional(),
  version: z.literal('1'),
  type: z.literal('pty'),
  permissionMode: z.enum(GUGU_PERMISSION_MODES).optional(),
  /** Initial prompt to deliver on first spawn (delivered once, gated on sessionId === null). */
  initialPrompt: z.string().optional(),
  /** Model to pass to the agent CLI. Empty string or absent = CLI default. */
  model: z.string().optional(),
  /** Reasoning-effort level for the model above. Absent = the CLI's own default for it. */
  effort: z.string().optional(),
  /**
   * spec session-graph:起这条会话的一方**显式**给的名字(`gugu_session spawn` 的 `title`)。
   * 它同时是这个 agent 在咕咕通讯录里的显示名(spec agent-provisioning「命名即寻址名」)。
   * 缺席 = 没人显式命名过,显示名回落到「<引擎 label> <序号>」自增约定。
   * ❌ 不许改读 `sessions.title` 代替它:那个字段「显式给的」与「从首轮推出来的」同形,
   * 读它等于把一整行提示词当成人名。Additive optional,两种形态口径一致。
   */
  agentDisplayName: z.string().optional(),
  titleSource: sessionTitleSourceSchema.optional(),
  providerSessionState: providerSessionStateSchema.optional(),
  pendingRestart: pendingRestartSchema.optional(),
  /**
   * spec session-resume:咕咕记着的那句**首轮**。新建的会话一定有它 —— 引擎侧什么都没落下时
   * (首轮没跑完、rollout 被删),照它原样重来就是 restart。分叉/导入没有这句话,字段缺席。
   * ❌ 不是投递载荷:载荷是上面的 `initialPrompt`,可能已经被投递路径搬走。
   */
  firstUtterance: z.string().optional(),
  startupOrigin: z.enum(['chat-page', 'session-page']).optional(),
  /** Stable id for a startup-delivered first user message. */
  initialMessageId: z.string().optional(),
  /** Typed session messages queued through sessions.sendMessage before the process is ready. */
  messageOutbox: z.array(sessionMessageSchema).optional(),
  /** Provider-neutral spawn lifecycle. Present only while a gugu_session spawn is starting. */
  spawnStartupState: spawnStartupStateSchema.optional(),
  /** 由另一台机器上的会话派出来的(见 spawnedByRemoteSchema)。Additive optional。 */
  spawnedByRemote: spawnedByRemoteSchema.optional(),
  /** Original requests for delegated work, including reuse of this agent. No chat content is copied. */
  activitySourceLinks: z.array(z.string()).optional(),
  /** 父会话在别的机器上(见 parentRemoteSchema)。Additive optional。 */
  parentRemote: parentRemoteSchema.optional(),
  /** spec session-fork-share: lineage marker — set when this conversation was forked
   * from another one (in-app fork or externally captured TUI fork). Additive optional. */
  forkedFrom: z
    .object({
      sessionId: z.string(),
      title: z.string(),
    })
    .optional(),
  /** Host-owned provider control endpoint for native session-TUI sessions. */
  providerSessionEndpoint: z.string().url().optional(),
  /**
   * spec session-runtime-switch:`sessions.provider_session_id` 里那个 id 是**引擎自己铸的**,
   * 不是咕咕拿 `--session-id <conversation.id>` 交给它的。
   *
   * 今天唯一的来源:一条通用模式(ACP)会话换到编程模式 —— 它的 provider 会话 id 由 ACP 适配器铸,
   * 与 conversation.id 不同。续跑必须用那个 id,❌ 不能回落到 conversation.id:那会指向一条根本
   * 不存在的会话,引擎于是起一条全新的空会话,而界面上一个字都不会说(2026-09-09 实测 claude)。
   *
   * ⚠️ 它记的是**这个 id 的来历**,不是又存一份 id —— id 只有 `session_id` 那一处。
   */
  providerMintedSessionId: z.boolean().optional(),
  /**
   * 资源库 → MCP:新建这条任务时带上的那几台(资源库里「默认启用」的)(名字)。每次开 / 续开按名字现取那台机器列表里的记录,
   * 经会话能力包送进去(`owner: 'integration'`)。缺席 = 一台都没带(或这一格之前的任务)。
   */
  libraryMcp: z.array(z.string()).optional(),
  /**
   * 事实:这条任务这一次起进程时,资源库带的那几台哪几台真送进去了、哪几台留在外面和为什么(`/mcp` 面板读它,
   * ❌ 读名单)。原因:这一家自己有同名的 / 资源库里已删 / 这条腿收不到 / 这条腿只收 http / 和咕咕自己的撞了。
   */
  mcpSessionLibrary: sessionLibraryMcpFactSchema.optional(),
});

const acpConfigV1 = z.object({
  subscriptionConnectionId: z.string().optional(),
  version: z.literal('1'),
  type: z.literal('acp'),
  permissionMode: z.enum(GUGU_PERMISSION_MODES).optional(),
  /** @deprecated Use initialQueue; kept so older in-progress ACP configs remain readable. */
  initialPrompt: z.string().optional(),
  /** Initial queued prompts to deliver on first spawn (delivered once, gated on sessionId === null). */
  initialQueue: z.array(initialQueuePromptSchema).optional(),
  /** Model to pass to the agent CLI. Empty string or absent = CLI default. */
  model: z.string().optional(),
  /** Reasoning-effort level for the model above. Absent = the CLI's own default for it. */
  effort: z.string().optional(),
  /**
   * spec session-graph:起这条会话的一方**显式**给的名字(`gugu_session spawn` 的 `title`)。
   * 它同时是这个 agent 在咕咕通讯录里的显示名(spec agent-provisioning「命名即寻址名」)。
   * 缺席 = 没人显式命名过,显示名回落到「<引擎 label> <序号>」自增约定。
   * ❌ 不许改读 `sessions.title` 代替它:那个字段「显式给的」与「从首轮推出来的」同形,
   * 读它等于把一整行提示词当成人名。Additive optional,两种形态口径一致。
   */
  agentDisplayName: z.string().optional(),
  titleSource: sessionTitleSourceSchema.optional(),
  providerSessionState: providerSessionStateSchema.optional(),
  pendingRestart: pendingRestartSchema.optional(),
  /** spec session-resume:口径与 pty 那份完全一致 —— 咕咕记着的那句首轮。 */
  firstUtterance: z.string().optional(),
  startupOrigin: z.enum(['chat-page', 'session-page']).optional(),
  /** Stable id for a startup-delivered first user message. */
  initialMessageId: z.string().optional(),
  /** Typed session messages queued through sessions.sendMessage before the runtime is ready. */
  messageOutbox: z.array(sessionMessageSchema).optional(),
  /** Provider-neutral spawn lifecycle. Present only while a gugu_session spawn is starting. */
  spawnStartupState: spawnStartupStateSchema.optional(),
  /** 由另一台机器上的会话派出来的(见 spawnedByRemoteSchema)。Additive optional。 */
  spawnedByRemote: spawnedByRemoteSchema.optional(),
  /** Original requests for delegated work, including reuse of this agent. No chat content is copied. */
  activitySourceLinks: z.array(z.string()).optional(),
  /** 父会话在别的机器上(见 parentRemoteSchema)。Additive optional。 */
  parentRemote: parentRemoteSchema.optional(),
  /** spec session-fork-share:谱系标记 —— 口径与 pty 那份完全一致。 */
  forkedFrom: z
    .object({
      sessionId: z.string(),
      title: z.string(),
    })
    .optional(),
  /** Host-owned provider control endpoint for native session-TUI sessions. */
  providerSessionEndpoint: z.string().url().optional(),
  /**
   * spec session-runtime-switch:`sessions.provider_session_id` 里那个 id 是**引擎自己铸的**,
   * 不是咕咕拿 `--session-id <conversation.id>` 交给它的。
   *
   * 今天唯一的来源:一条通用模式(ACP)会话换到编程模式 —— 它的 provider 会话 id 由 ACP 适配器铸,
   * 与 conversation.id 不同。续跑必须用那个 id,❌ 不能回落到 conversation.id:那会指向一条根本
   * 不存在的会话,引擎于是起一条全新的空会话,而界面上一个字都不会说(2026-09-09 实测 claude)。
   *
   * ⚠️ 它记的是**这个 id 的来历**,不是又存一份 id —— id 只有 `session_id` 那一处。
   */
  providerMintedSessionId: z.boolean().optional(),
  /**
   * spec session-fork-share:要分叉的**来源 provider 会话 id**,首次启动时用它走 ACP 的
   * `session/fork`,拿回一个独立的新 provider 会话 id 落进 `session_id`,此后这条会话就是
   * 一条普通的 ACP 会话(靠 `session/load` 重开)。
   *
   * ⚠️ 与运行时分叉(侧边聊天)**不是同一件事**:那条不落库、不进会话列表,走的是
   * `session/new` + `_meta{resume, forkSession, persistSession:false}`,产出的 id 就是来源的。
   * 这条要的正好相反 —— 一个**真正独立**的 id,而 `session/fork` 给的就是它。
   *
   * 只在「还没认领首启」时有意义:`session_id` 一旦写下,分叉就已经发生过了。
   */
  forkFromProviderSessionId: z.string().optional(),
  /**
   * spec `mcp-session-toggle`:用户在 `/mcp` 面板里为**这一条会话**留下的开关。
   *
   * `mcpDisabledServers` 记的是**关掉的那几台**(而不是启用集合),因为「用户没碰过的都开着」
   * 是默认:记启用集合的话,用户配置里新加的一台会**默认变成关的** —— 一个他从没做过的决定。
   * 名字是 **harness 自己的配置键**,与 `readServers` 读回来的逐字相同(❌ 不是展示名)。
   *
   * `mcpToggleDecided` 与它**分开**记,不能用「数组非空」代替:
   * 用户可能把所有开关都打开又确认一次 —— 那时数组是空的,但这条会话**已经动过**,
   * 而连接键要的是「动过没有」(独占适配器),不是「现在关着几台」。
   * 用数组非空推导 = 用户把开关全打开的那一刻,会话悄悄从独占掉回池化,而他什么都没做。
   */
  mcpDisabledServers: z.array(z.string()).optional(),
  /** 这条会话是否已经由用户显式决定过 MCP 开关(⇒ 独占适配器进程,且**不再回退**)。 */
  mcpToggleDecided: z.boolean().optional(),
  /**
   * 这条会话**起进程那一刻被带上**的那几台 MCP server(spec `mcp-session-toggle`)。
   *
   * ⚠️ 它与上面两个是**事实 vs 意图**的关系,两样都要记,少一样就有一半会撒谎:
   * - 意图 = `用户配置 ∖ mcpDisabledServers` —— 回答「**下次**起会带哪几台」;
   * - 事实 = 这一格 —— 回答「**这条正在跑的会话**里有哪几台」。
   *
   * 只有意图时,面板会对两件事说假话(owner 2026-09-07 亲自撞到第一件):
   * ① 会话起来**之后**用户在全局装了一台新的 ⇒ 它不在关闭集合里,面板算出「开着」,
   *    而这条会话的进程里**根本没有它**;
   * ② 反向更糟:会话起来之后**卸载**的那台从全局清单里消失 ⇒ 面板整行不见,
   *    而它**还在这个进程里活着、工具还调得动**。用户以为卸了,其实没有。
   *
   * ⚠️ 名字叫「起进程时带上的」而**不是「已装载的」**:咕咕在 spawn 那一刻读的是用户配置的
   * **快照**,并没有观察到 harness 真的把它们拉起来 —— 叫「已装载」是一句我们没证据的话。
   *
   * ⚠️ 缺席 = 这条会话是这个字段存在之前起的(老会话)。那时面板退回只用意图算,
   * 并在下一次重开时自己写实 —— ❌ 不给横幅、不给 unknown 态:它会自愈。
   */
  mcpSessionServers: z.array(z.string()).optional(),
  /**
   * #6387 起进程那一刻,咕咕替已装扩展交付进这条会话的 MCP 程序与技能(事实)。
   * 与 `mcpSessionServers` 同一时刻写、同一条理由:扩展会话中途装卸/升级,已开会话保持启动时那一版,
   * 面板要说的是这条会话里**有**什么,❌ 不是现在装着什么。缺席 = 这个字段之前起的会话。
   */
  mcpSessionExtensions: z
    .object({
      servers: z.array(z.object({ name: z.string(), extensionId: z.string() })),
      skills: z.array(z.object({ name: z.string(), extensionId: z.string() })),
    })
    .optional(),
  /** #7342 引擎最后一次报的上下文读数(见 `sessionContextUsageSchema`)。缺席 = 还没报过,或这一格之前的会话。 */
  contextUsage: sessionContextUsageSchema.optional(),
  /**
   * 资源库 → MCP:新建这条任务时带上的那几台(资源库里「默认启用」的)(名字)。每次开 / 续开按名字现取那台机器列表里的记录,
   * 经会话能力包送进去(`owner: 'integration'`)。缺席 = 一台都没带(或这一格之前的任务)。
   */
  libraryMcp: z.array(z.string()).optional(),
  /**
   * 事实:这条任务这一次起进程时,资源库带的那几台哪几台真送进去了、哪几台留在外面和为什么(`/mcp` 面板读它,
   * ❌ 读名单)。原因:这一家自己有同名的 / 资源库里已删 / 这条腿收不到 / 这条腿只收 http / 和咕咕自己的撞了。
   */
  mcpSessionLibrary: sessionLibraryMcpFactSchema.optional(),
});

export const sessionConfig = defineVersionedSchema()
  .unversioned(sessionConfigV0Schema)
  .version(
    '1',
    z.discriminatedUnion('type', [ptyConfigV1, acpConfigV1]),
    (v0) =>
      ({
        version: '1' as const,
        type: 'pty' as const,
        ...(v0.permissionMode !== undefined && { permissionMode: v0.permissionMode }),
        initialPrompt: v0.initialPrompt,
        model: v0.model,
        // providerSessionId is intentionally dropped; it now lives in sessions.provider_session_id
      }) satisfies z.infer<typeof ptyConfigV1>
  )
  .build();

export type SessionConfig = typeof sessionConfig.Type;
export type SessionConfigPty = z.infer<typeof ptyConfigV1>;
export type SessionConfigAcp = z.infer<typeof acpConfigV1>;
