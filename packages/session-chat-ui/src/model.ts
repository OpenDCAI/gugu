import type { HookNotice } from './lib/hook-notice';
import type { BackgroundCommandEntry } from './lib/background-command-roster';
import type { SubagentRosterEntry } from './lib/subagent-roster';
import type { DeliveryReading } from '@gugu/core/local/agent/deliveryEnvelope';
import type { AgentSend } from '@gugu/session-core/session-record/reply-process';
import type {
  AcpPermissionRequest,
  OpenedOutput,
  PlanEntryPriority,
  PlanEntryStatus,
  PlanState,
  SessionPlans,
  TerminalExit,
  ToolNode,
  ToolStatus,
  TranscriptItem,
  TranscriptMessage,
  TranscriptThinking,
  TranscriptTurn,
  TranscriptTurnOutcome,
} from '@gugu/session-core/acp/client';
import type { ToolRunNow } from '@session-chat/state/tool-run';

export type {
  AcpPermissionRequest,
  OpenedOutput,
  PlanEntryPriority,
  PlanEntryStatus,
  PlanState,
  SessionPlans,
  TerminalExit,
  ToolNode,
  ToolStatus,
  TranscriptItem,
  TranscriptMessage,
  TranscriptThinking,
  TranscriptTurn,
  TranscriptTurnOutcome,
};

export type ChatRole = 'user' | 'assistant' | 'thought';

export type ThinkingStatus = 'thinking' | 'done';

/**
 * An image attachment shown as a thumbnail at the top of a user message bubble.
 *
 * `dataUrl` carries the inline image for display; when it is absent (the source
 * content could not be resolved, e.g. on reload when the agent did not replay
 * the bytes) the renderer shows a neutral fallback tile instead.
 */
export type ChatAttachment = {
  id: string;
  name: string;
  /**
   * 画成缩略图还是画成一枚文件 chip。缺席 = `'image'`(历史生产者只送图)。
   *
   * ⚠️ 两种都长在**同一条附件条**上 —— owner 2026-09-10:「这里的逻辑和创建任务时候保持
   * 一致才对」。此前非图片附件是正文里一枚裸的文字 pill,同一条消息里两件附件长成两个样子。
   */
  kind?: 'image' | 'file';
  /** Data URL for inline display; absent when content can't be resolved -> fallback tile. */
  dataUrl?: string;
};

/** @deprecated 用 `ChatAttachment` —— 附件条不再只画图。 */
export type ChatImageAttachment = ChatAttachment;

export type ChatMessage = {
  kind: 'message';
  id: string;
  /** View-only durable source; null means the runtime row has no safe persistent identity yet. */
  sourceItemId?: string | null;
  seq?: number;
  role: ChatRole;
  /** Markdown source text. */
  text: string;
  /** True while the agent is still writing to this message. */
  streaming?: boolean;
  /** Image attachments rendered as a thumbnail strip above the text (user messages). */
  attachments?: ChatAttachment[];
  /**
   * 这条消息**开始**到达的时刻（epoch ms）。缺席 = 不知道（回放来的历史没有真时刻，
   * 与 `TranscriptTurn.startedAt` 同一条合同）。折叠头拿它当段与段的边界（#5350）。
   */
  at?: number;
  /** Parsed Gugu delivery metadata; populated by the message unit, never by ordinary transcript producers. */
  guguDelivery?: DeliveryReading;
  /**
   * View-only reference to the message this one explicitly replies to. Only a real anchor counts
   * (the delivery's `reply_to`, or the `reply_to_message_id` the agent passed to message_send) —
   * ❌ guessed from "the previous input" (owner 10-28: 参数里有什么就传什么). `from` is the quoted
   * message's own sender (an agent or a person), `self` marks a quote of this agent's own earlier send,
   * `chatId` the group the quoted message was said in (absent for a DM).
   */
  conversationReply?: { itemId: string; text: string; from?: string; fromId?: string; self?: boolean; chatId?: string; unloaded?: boolean };
  /** The `reply_to_message_id` (without `msg:`) of the message_send this `:sent:` row came from. */
  sentReplyTo?: string;
  /**
   * View-only: something the agent said along the way (not the turn's reply). Drawn as one gray line among the
   * steps under the process line (design 0), ❌ a bubble of its own.
   */
  conversationNarration?: boolean;
  /** The replay segment is live and this reply is its last event (not merely an active turn). */
  conversationCaret?: boolean;
  /** View-only: the closing reply of a finished turn — the only agent bubble with the time / copy row (design 0 `tail`). */
  conversationTail?: boolean;
  /** Where this message_send output went (same reading as the session page's 「发到 …」 line, `agentSendOf`). */
  sentTo?: AgentSend['to'];
  /** The `chat_id` that message_send went to — names the group when this row is itself quoted later. */
  sentChat?: string;
  /** View-only disclosure of the completed thinking/execution segment. */
  conversationProcess?: { live?: boolean; id: string; startedAt?: number; endedAt?: number; idleMs?: number; steps?: number; empty?: boolean; trigger?: TurnProcessItem['trigger'] };
  /**
   * View-only split of one agent-conversation reply (owner 0 号图): `head` draws the name and the
   * process line, each `body` only a bubble. The process steps go between them, so they never land
   * under the bubble; every output of the turn (message_send ones too) is its own bubble.
   */
  conversationPart?: 'head' | 'body';
  /** A `body`'s head row — background tasks still hang on that process line. */
  conversationHead?: string;
  /**
   * 这条其实是某个 hook 说的话，不是 agent 的回复（#4981）。与 `guguDelivery` 同一路数：
   * 由消息单元从正文里解出来（见 `lib/hook-notice.ts`），❌ transcript 生产者不写它。
   */
  hookNotice?: HookNotice;
  /**
   * 这条用户消息其实是宿主替主人交来的回答(`<gugu_question_answer>`,gugu-dev#181 ⑨):画成一行「你回答了：X」,
   * ❌ 把那段 XML 原样摆进气泡。由消息单元从正文里解出来,与 `hookNotice` 同一路数。`answer` = null:问题被收回了。
   */
  questionAnswer?: { answer: string | null };
};

export type ChatToolCall = {
  kind: 'tool';
  id: string;
  name: string;
  status: ToolStatus;
  awaitingPermission?: boolean;
  /**
   * Why this call failed, when the host knows it as a separate string.
   *
   * ⚠️ Nothing on the ACP path sets this: a tool call has no error field in the
   * protocol, and a failure's text arrives in the same `content` the reducer
   * decodes into `result`. So on the product path the failure section reads
   * `result`, and this field is only for hosts that genuinely hold the reason
   * apart from the output. Setting both keeps both — they are then two readings,
   * not one text stored twice.
   */
  error?: string;
  /** Short one-line synopsis shown alongside the tool name. */
  inputSummary?: string;
  /**
   * The arguments the agent handed the tool, shown in the expanded request
   * panel. Absent when the provider reported none — the row then has nothing to
   * expand and renders as a plain line, exactly as it did before the panel
   * existed.
   */
  request?: string;
  /** What the tool returned, shown in the expanded result panel. */
  result?: string;
  /** A measured disclosure explaining transport-shortened tool content. */
  transportNote?: string;
  /**
   * 工具交回来的图(画图用的地址),在头下面画成一条缩略图 —— 不用点开就看得见,见 tool-images.ts。
   * 缺席 = 这次调用没交图,行和从前一样。
   */
  images?: string[];
  /** Includes pictures represented by lazy transport references. */
  imageCount?: number;
  /** Id of the parent tool call (for hierarchical rendering). */
  parentId?: string;
};

export type SubagentPhase = 'spawning' | 'running' | 'completed' | 'failed';

/**
 * 一次**并行派发**的卡组(#4981),对应上游 `elements-subagent-list`。
 *
 * 上游那句话是这套东西的全部理由:「派给多个子 agent 天然就是一个回合里的多次工具调用,
 * 一个 worker 一次;**这个列表不是任何单次调用的 UI,它是从所有调用汇总出来的**。」
 * 所以它不是新工具,是若干 `subagent` 行的聚合 —— 派五个就是一组五张卡,而不是五行散落。
 *
 * ⚠️ 这里**没有内层折叠**:外面 `turn-process` 已经折过一层了(#4874/#4981),
 * 再套一层就要点两次才看得见人。上游同样没有折叠 —— 列表本身就是视觉主体。
 */
export type ChatSubagentListItem = {
  id: string;
  /** 派它去做什么 —— 卡上那行字。拿不到就退到通用词,❌ 不编。 */
  name: string;
  /** 它实际跑在哪个模型上;供应商没给就不画这一格。 */
  model?: string;
  status: ToolStatus;
  phase: SubagentPhase;
  /** 它自己已经跑完的步数 —— 卡上写的就是这个数(owner:「步数才能表达出来进度」)。 */
  completedSteps: number;
};

export type ChatSubagentList = {
  kind: 'subagent-list';
  id: string;
  agents: readonly ChatSubagentListItem[];
};

export type ChatSubagentToolCall = {
  reasoning?: string;
  kind: 'subagent';
  id: string;
  name: string;
  status: ToolStatus;
  phase: SubagentPhase;
  agentId?: string;
  request?: string;
  result?: string;
  /** A measured disclosure explaining transport-shortened tool content. */
  transportNote?: string;
  /**
   * 这个子任务被要求做什么（#4981）——供应商在派活时给的那句描述。
   *
   * ⚠️ 叫 `task` 不叫 `inputSummary`:行上要说的是**领域概念**（这个子 agent 干嘛去了），
   * 不是它从哪个传输字段来的。
   *
   * 没有它的时候,并行派出去的 N 个子任务在界面上是 N 行一模一样的「Agent 已完成」——
   * 入口解码保留原生派活描述，领域条目通过 `inputSummary` 传到这里，按任务正文展示。
   */
  task?: string;
  background?: boolean;
  awaitingPermission?: boolean;
  /** Optional failure message shown in the failed state tooltip. */
  error?: string;
  /** Id of the parent tool call (for hierarchical rendering). */
  parentId?: string;
};

/**
 * A thinking / reasoning row produced by the agent before it replies.
 *
 * While `status === 'thinking'` the row shows a fixed-height streaming window
 * with the tail of the reasoning text truncated/faded at the top.
 * When `status === 'done'` the row collapses to a "Thought for {duration}s"
 * header that can be expanded to reveal the full reasoning text.
 */
export type ChatThinking = {
  kind: 'thinking';
  id: string;
  seq?: number;
  segmentId?: string;
  status: ThinkingStatus;
  text: string;
  startedAt: number;
  durationMs?: number;
};

/** ACP tool-call categories that represent file operations. */
export type FileOpKind = 'read' | 'edit' | 'delete' | 'move';

/** A single file touched by a file-operation tool call. */
export type FileOp = {
  path: string;
};

/**
 * A file-operation tool call row (read / edit / delete / move).
 *
 * Single file (ops.length <= 1): renders as an inline row, e.g. "Read foo.tsx".
 * When a payload exists, the row discloses it and the filename still opens the file.
 * Multiple files (ops.length > 1): renders as a collapsible header "Read 2 files ›"
 * that expands to a per-file list. While `status === 'running'` the collapsed
 * header shows a fixed-height streaming preview window (like ChatThinking).
 *
 * Collapse semantics are inverted: the stored "collapsed" bool means "expanded"
 * (same convention as ChatThinking).
 */
export type ChatFileOpToolCall = {
  kind: 'file-op';
  id: string;
  op: FileOpKind;
  status: ToolStatus;
  request?: string;
  result?: string;
  /** A measured disclosure explaining transport-shortened tool content. */
  transportNote?: string;
  awaitingPermission?: boolean;
  /** Optional failure message shown in the error icon's native tooltip. */
  error?: string;
  /** Accumulating list of files touched. Replaced (not appended) on each update. */
  ops: FileOp[];
  /** Id of the parent tool call (for hierarchical rendering). */
  parentId?: string;
};

/**
 * An execute tool call row — ACP `kind: 'execute'` commands (e.g. Bash).
 *
 * A collapsible header line ("Execute" or the provider's inputSummary) above a
 * monospace body carrying the command and its output, clamped in the collapsed
 * state and scrollable when expanded. Original arguments and additional result
 * metadata use the shared tool payload panel under that body.
 *
 * `startedAt` / `durationMs` have no producer on the ACP path — the presenter
 * writes `startedAt: 0` and never writes `durationMs`, and no execute renderer
 * reads either. They describe a row-local timer this row does not have; only
 * thinking carries one. Treat them as unpopulated, not as available readings.
 */
export type ChatExecute = {
  kind: 'execute';
  id: string;
  /** The shell command, e.g. "ls -a". Empty string until the command-bearing update arrives. */
  command: string;
  /** Optional provider-supplied purpose shown as the execute card title. */
  inputSummary?: string;
  /** Static tool output, or live terminal output when available. */
  outputText?: string;
  request?: string;
  result?: string;
  /** A measured disclosure explaining transport-shortened tool content. */
  transportNote?: string;
  status: ToolStatus;
  awaitingPermission?: boolean;
  /** Optional failure message shown in the error icon's native tooltip. */
  error?: string;
  /** Unpopulated on the ACP path — see the type's doc comment. */
  startedAt: number;
  /** Unpopulated on the ACP path — see the type's doc comment. */
  durationMs?: number;
  terminalId?: string;
  /**
   * How the embedded terminal's process ended, once it has ended.
   *
   * Read from the shared snapshot, whether the agent or host owns the process.
   * Missing means no exit was reported; it grants no control of that process.
   * Absent is never rendered as success.
   */
  exitStatus?: TerminalExit;
  /** Id of the parent tool call (for hierarchical rendering). */
  parentId?: string;
};

/** One tool's canonical patch blocks, projected without rebuilding file contents. */
export type ChatDiff = {
  kind: 'diff';
  /** The same tool identity in preview and result. */
  id: string;
  /** Full canonical blocks; this view never reconstructs file contents. */
  patches: import('@gugu/session-core/acp').SessionPatch[];
  status: ToolStatus;
  awaitingPermission?: boolean;
  /** Optional failure message shown in the error icon's native tooltip. */
  error?: string;
  /** Id of the parent tool call (for hierarchical rendering). */
  parentId?: string;
};

/**
 * Resolved addressing target for a resource link.
 *
 * `workspace-file` — the URI resolves to a file inside the current workspace;
 *   `path` is the workspace-relative or absolute path, ready for the editor.
 * `external` — an http(s) URL or other browser-openable resource.
 * `opaque` — a custom MCP server scheme the client cannot resolve locally.
 */
export type ResourceTarget =
  | { kind: 'workspace-file'; path: string }
  | { kind: 'external'; url: string }
  | { kind: 'opaque' };

/**
 * A resource-link row — produced by ACP `resource_link` content blocks inside
 * agent messages, emitted as a standalone row (split from the surrounding message).
 *
 * The `target` is pre-resolved by the desktop enrichment transform before the
 * item enters chat-ui, so the renderer stays transport-agnostic.
 *
 * Renders as a compact card: mime icon, `title ?? name`, secondary line
 * derived from `target` (path / host / scheme), and optional size.
 * Clicking a `workspace-file` target opens it in the editor.
 */
export type ChatResourceLink = {
  kind: 'resource-link';
  id: string;
  /** Original ACP URI, preserved for display and copy. */
  uri: string;
  /** Required resource name. */
  name: string;
  /** Optional human-friendly label (preferred for display over `name`). */
  title?: string;
  /** Optional one-line description shown below the title. */
  description?: string;
  /** MIME type hint; drives the file-type icon. */
  mimeType?: string;
  /** File size in bytes; shown when present. */
  size?: number;
  /** Pre-resolved addressing target. */
  target: ResourceTarget;
  status?: ToolStatus;
  /** Optional failure message shown in the error icon's native tooltip. */
  error?: string;
};

/** Lifecycle status of a single plan entry. Mirrors ACP `PlanEntryStatus`. */
/**
 * A single task entry within an agent execution plan.
 *
 * `content` is a markdown-capable description of the task.
 * `status` and `priority` mirror the ACP `PlanEntry` schema.
 */
export type ChatPlanEntry = {
  content: string;
  status: PlanEntryStatus;
  priority: PlanEntryPriority;
};

/**
 * An agent execution plan row — produced by ACP `plan` / `plan_update` session updates.
 *
 * Renders as a collapsible checklist (collapsed by default to a capped preview
 * window; click the header to expand the full list). Each entry shows a status
 * glyph (○ / ◐ / ●) and its markdown content (wrapped text). The plan replaces
 * its entries wholesale on each ACP update.
 *
 * While `streaming` is true, entries are still being appended: the collapsed
 * preview auto-scrolls to the newest task and the header shimmers. Cleared on
 * turn completion.
 */
export type ChatPlan = {
  kind: 'plan';
  id: string;
  entries: ChatPlanEntry[];
  body?: { type: 'markdown'; content: string } | { type: 'file'; uri: string };
  /** True while tasks are still being appended (drives preview auto-scroll + shimmer). */
  streaming?: boolean;
};

export type TurnOutcomeItem = {
  kind: 'turn-outcome';
  id: string;
  /** 这一行所收尾的那个 turn。「丢弃」按 turn 记状态，所以行里必须拿得到它。 */
  turnId: string;
  outcome: TranscriptTurnOutcome;
  /**
   * 这一轮的原始用户指令，由 `flattenTier` 从 turn 自己的第一条 user message 抄来；
   * 只有 `initiator === 'user'` 的 turn 有。agent 自己发起的后台 turn 没有指令可还，
   * 于是这里是 undefined，那一行就不渲染「取回指令」（见 `ChatCommands.onRestorePrompt`）。
   */
  prompt?: string;
};

/**
 * 一轮交出来的一份东西,画成一张附件卡,挂在这一轮最后那条回复下面。
 * 由 `flattenTier` 从这一轮成功的 `session_open_in_tab` 调用造出来:那次调用照常是过程里的一步,
 * 卡片另挂在最后。同一份东西一轮只挂一张。
 */
export type OpenedOutputItem = {
  kind: 'opened-output';
  id: string;
  turnId: string;
  output: OpenedOutput;
  /** 这一组里第几张(从 0 数)、一共几张:一组卡连成一块时,首尾的圆角与中间的分隔线靠它。 */
  index: number;
  count: number;
};

/**
 * 日界分隔行：它下面那些 turn 属于一个新的日历日。
 *
 * 由 `flattenTier` 在 turn 的日历日发生变化时插进单元流，**不是**某条消息的一部分 ——
 * 它有自己的 item id，所以 `scrollToItem(某条消息)` 仍然落在那条消息上，而不是落在
 * 它头顶的日界上。
 *
 * `startedAt` 抄自开启这一天的那个 turn 的 `TranscriptTurn.startedAt`，因此它永远是一个
 * 真实读数：没有时刻的 turn 根本不会产生这一行（见 turn.ts 上 `startedAt` 的合同）。
 */
export type DaySeparatorItem = {
  kind: 'day-separator';
  id: string;
  /** Epoch ms —— 这一天第一个 turn 的开始时刻。 */
  startedAt: number;
};

/**
 * 一轮工作的时间头（#4874 → #4981）：用户问一句之后、最终回复之前的全部事情
 * （语义折叠后的工具句、中间发言、改动）上面的一行，写的是**跑了多久**。
 *
 * owner 2026-09-06：「我的 toolcall 以语义的形式来表达,多个 toolcall 拼成一段带量化的
 * 一段话……这也是折叠。整体来讲,就套个时间头」「时间头本身算是过程的折叠,只不过是运行
 * 完成后,时间头是对过程的折叠」。
 * ⇒ 跑着的时候「已处理 16s」在数、底下的内容摊开着看得见；跑完了同一条头收起整轮过程
 * （不分几步，点开还原），写总时长。语义句（`tool-run`）是过程**里**的折叠，头是整轮的。
 * ❌ 不再写「过程 · N 步」。agent 自己开头的一轮（后台命令跑完、完成通知把它叫醒）同样有头、
 * 只留最后一句话（#69，owner 2026-10-22，推翻 09-06「自发轮没有头」）；跑完却一句话没留下的不套头。
 *
 * 由 `flattenTier` 在宿主开了 `SegmentCtx.foldTurnProcess`（Base 视图）时插进单元流；
 * 展开与否读的是 ViewState 的那一把折叠开关（同 tool-group），所以切 tab、重挂 view
 * 都不丢。被用户打断（cancelled）或异常（error）收尾的轮没有头——那些轮本来就带
 * turn-outcome 行，过程正是读者要看的东西。
 *
 * 回放拿不到 outcome（`loadSession` 只重放内容、不重放回合边界），已提交层里
 * outcome 缺席实际只有这一个来源，按「不折」处理会让重开的会话一条都不折 ——
 * 所以缺席也折，判据见 `planTurnFold`。
 */
export type TurnProcessItem = {
  kind: 'turn-process';
  id: string;
  turnId: string;
  /** This segment explicitly chose silence; a status label, never an assistant reply. */
  silent?: boolean;
  /** A retained acknowledgement with no expandable agent activity. */
  empty?: boolean;
  /**
   * 这一轮还在跑：头上的时间在数、带微光，底下的内容**默认摊开**（点一下收起）；
   * 落定后同一条头默认收起、写的是总时长（点开还原）。
   */
  live?: boolean;
  /**
   * 头底下看得见这一轮的内容(摊开着的过程,或它占位时下面那句话)。有内容时「agent 在动」由那些行自己的
   * 微光负责,头不带微光(同屏两处一起扫就是闪);一轮刚发出、下面还空着,或人把头收起来了,头是这一轮
   * 唯一的动静,才自己微光。
   */
  withBody?: boolean;
  /** 对话布局:过程行上写的「· N 步」(折在这条头下面的行数)。还没出回复、只有头的那一轮也要写(owner 0 号图「执行中 · 9m16s · 39 步」)。 */
  steps?: number;
  /**
   * 对话布局、在跑:这一轮不是主人手打起的(群消息投递、定时任务、agent 自己起的)。过程行写清在干什么
   * (「执行中 · 处理「gugu」群消息」),❌ 只露出后台药丸(管家 10-28:主人手打的消息不能被不是他发起的事挡住)。
   */
  trigger?: { kind: 'delivery' | 'schedule' | 'agent'; chatIds?: string[] };
  /**
   * 占位:跑着、还没有可折的过程(`placeholderTurnHeader`)。写「正在思考…」、不数秒、没有箭头 ——
   * 下面没有可展开的东西,点了没反应的箭头比没有箭头更糟;过程一到,同一个 id 的头接手。
   */
  placeholder?: boolean;
  /**
   * 这一轮什么时候开始的（`TranscriptTurn.startedAt`）。缺席 = 不知道（回放来的），
   * 那就不写时间 —— 一个会少报的计时器比没有计时器更糟（`turn-process.def.tsx` 头注）。
   * ❌ 不拿组件挂载时刻代替：虚拟列表滚出视窗就卸载，滚回来会从 0 重数。
   */
  startedAt?: number;
  /** 这一轮什么时候结束的（并进来的话是最后一个回合的 `endedAt`）。缺席 = 不知道。 */
  endedAt?: number;
};

/** Action strip after a known completed turn that did not produce reply text. */
export type TurnCompletionItem = {
  kind: 'turn-completion';
  id: string;
  turnId: string;
  text: string;
};

/**
 * 一段**连续的工具调用**折成的一句话（#4981，owner 2026-09-06）：
 * 「搜索了 3 个模式、读了 2 个文件、跑了 12 条命令」。
 *
 * owner 的模型：除文本消息之外全是 tool call，连续的 tool call 可以折叠；文本与思考不折
 * （改文件起初不折，owner 同日改口「除了 ai 文本以外都语义化折叠」）。
 * 这就是 Claude Code 里「Searched for 3 patterns, read 2 files, ran 12 shell commands」那一行。
 * 展开还原成原始行；两条起折，一条就是一行。切段规则见 `state/tool-run.ts`。
 *
 * 与 `turn-process` 的关系：人问的那一轮外面套一条时间头（语义折叠后还剩两行以上才有开合，
 * 只剩这一句时头只写时长、不折）；agent 自己开头的一轮同样套头（#69），只有一句话都没留下的那种平铺，
 * 这一句自己就是折叠。
 * 展开与否读的是同一把 ViewState 开关。
 */
export type ToolRunItem = {
  kind: 'tool-run';
  id: string;
  turnId: string;
  /** 已经成句的摘要。由 flatten 用宿主的 translator 拼好，行里只画。 */
  label: string;
  /** 折进去的行数。 */
  stepCount: number;
  /** 这一段里还有在跑的调用（活动层）⇒ 头上微光。 */
  live?: boolean;
  /** 跑着的这一段此刻在做什么(`toolRunNow`):在跑的命令或在思考;只在活动层、只在有的时候写。 */
  now?: ToolRunNow;
};

/**
 * 这条会话**此刻**的状态：引擎没装、正在更新、要登录、连接断了、provider 那侧的会话没了……
 *
 * # 为什么它是 Synthetic（视图自己造的行），而不是转录条目
 *
 * owner 2026-09-19：「任何 bug 都不应该让会话打不开才对吧,也不应该有任何需要横幅性质的
 * ui 表达,有问题就像消息一样贴消息列表才对吧」⇒ 位置是列表里的一行。
 *
 * 但它与 `session-notice`（转录条目）**不是**一件事，判据是**寿命**：
 * - `session-notice` 记的是**发生过**的事（模型没了、上下文被重开），属于这段历史，落库、重开还在；
 * - 这一条记的是**现在的条件**（引擎还没装上），条件一消失它就该消失 ⇒ ❌ 不进历史，
 *   否则装好引擎之后，那句「没装」会永远留在对话里。
 *
 * ⇒ 它跟 `working` / `turn-outcome` 同族：由 flatten 按会话状态当场造出来，贴在列表末尾。
 */
export type SessionConditionItem = {
  kind: 'session-condition';
  id: string;
  /** 哪一种条件。行上的文案与内联动作按它取，❌ 不去匹配 detail 里的文字。 */
  code: SessionConditionCode;
  /** Whether the transcript actually renders content above this row, derived by flatten. */
  hasVisibleHistory: boolean;
  /** 运行时/provider 自己那句原文，给排查用（悬停可见），❌ 不摊进正文。 */
  detail: string;
  /**
   * 宿主已经按界面语言写好的那句话，替换 code 的默认说法。只给「这一刻的状态」要带数字 / 名字的条件用
   * （例如别的机器断线时「和 Linux 1 的连接断了，5 秒后重连」，#6264）；缺省 = 按 code 取默认文案。
   */
  label?: string;
  /**
   * 这一刻能做的事，按重要性排，最多两件；没有就只说事实（例如引擎正在更新：等几秒就好）。
   *
   * ⚠️ 为什么允许两件：登录闸那一条两件都不能少 —— owner 2026-09-04 的原话是
   * 「我已经登录了,这里没有个登录完成的按钮」。「去登录」与「我登好了」是两个不同的动作，
   * 后者读作「我登好了，接着来」，❌ 不能用「重试」顶替。
   */
  actions?: readonly { label: string; run: () => void }[];
  /** 行文案里的占位值(按 code 取到的那句文案里要填的空)。 */
  labelValues?: Readonly<Record<string, string | number>>;
};

export type SessionConditionCode =
  | 'harness-missing'
  | 'harness-updating'
  | 'auth-required'
  | 'provider-session-missing'
  | 'adapter-lost'
  | 'start-failed'
  /** 会话在**别的机器**上,而那台机器此刻问不到(离线 / 没回话)(#6264)。 */
  | 'machine-unreachable'
  /** 那台机器连得上,但有件事要人知道:磁盘快满了、两边版本对不上(#6264)。宿主总是给 label。 */
  | 'machine-attention'
  /**
   * 这条会话用的咕咕模型要开会员才能用(会员中途到期,#7056)。下一轮之前就停下说清,给两条去路:
   * 换一个模型、去网页续费 —— ❌ 悄悄换模型接着跑。
   */
  | 'membership-required'
  /** 上一轮被宿主的退出打断了(更新 / 重启 / 没正常退出):开机收残记下的,下一轮开工就没了。宿主总是给 label。 */
  | 'turn-interrupted';

export type SessionCondition = Omit<SessionConditionItem, 'kind' | 'id' | 'hasVisibleHistory'>;

/**
 * 还在跑的后台任务 —— 主智能体起的后台命令、派出去的子智能体 —— 贴在消息列表**最后一行**。
 *
 * owner 2026-10-27:右上角「摘要」按钮去掉,后台任务直接放进主对话。它们不挂住这一轮(后台命令轮当场收口、
 * 进程照跑),所以「还有东西在跑」只能由列表末尾这一行来说;点开就地展开成一张逐行的单子,能停、能收起。
 *
 * 与 `session-condition` 同族:视图按此刻的状态当场造出来,❌ 不进历史 —— 跑完、停掉、收起,这一行就没了。
 */
export type BackgroundTasksItem = {
  kind: 'background-tasks';
  id: string;
  commands: readonly BackgroundCommandEntry[];
  subagents: readonly SubagentRosterEntry[];
  /** 单子展开着没有(人点那一行切换;默认收着)。 */
  expanded: boolean;
};

/**
 * agent 经 message_send / session_message 说出去的一段话,画成它说的话、标明发到了哪里。
 * 由 `flattenTier` 从那次调用造出来(判据 `agentSendOf`),在它原来的位置上顶替那一行工具;id 就是那次调用的 id。
 */
export type AgentSendItem = {
  kind: 'agent-send';
  id: string;
  turnId: string;
  send: AgentSend;
  /** 还在发 / 已发出(那次调用的状态;发失败的不造这一项,照常是一行工具)。 */
  status: 'running' | 'done';
};

/** Successful file edits presented once below a settled turn's reply. */
export type FileChangeSummaryItem = {
  kind: 'file-change-summary';
  id: string;
  turnId: string;
  files: { path: string; diffs: ChatDiff[]; adds: number | null; dels: number | null }[];
  adds: number | null;
  dels: number | null;
};

export type SyntheticItem =
  | SessionConditionItem
  | BackgroundTasksItem
  | TurnOutcomeItem
  | OpenedOutputItem
  | AgentSendItem
  | FileChangeSummaryItem
  | DaySeparatorItem
  | TurnProcessItem
  | TurnCompletionItem
  | ToolRunItem;

export type ChatItem =
  | TranscriptItem
  | ChatMessage
  | ChatToolCall
  | ChatSubagentToolCall
  | ChatSubagentList
  | ChatThinking
  | ChatFileOpToolCall
  | ChatExecute
  | ChatDiff
  | ChatResourceLink
  | ChatPlan;
