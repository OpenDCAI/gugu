/**
 * The internal normalized event type consumed by the AcpTranscriptParser reducer.
 *
 * NormalizedEvent is a decoded domain delta, shared by transport and native
 * history ingress. The reducer never inspects a protocol notification.
 * TranscriptItem is the accumulated materialized state.
 *
 * Contrast with TranscriptItem (accumulated materialized state).
 */

import type {
  SessionConfigOption,
  ToolCallLocation,
} from '@agentclientprotocol/sdk';
import type { AttachmentRef } from '../models/attachments';
import type { SessionCommandDefinition, SessionUsage } from '../models/config';
import type { PlanEntryInput } from '../models/plan';
import type { SessionNoticeCode } from '../models/turns/session-notice';
import type { TranscriptTurnTrigger } from '../models/turns/turn';
import type { ToolImage } from '../models/turns/tool-calls';
import type { TerminalExit, TerminalState } from '../models/terminals';
import type { EntityContent, EntityMeta } from '../models/entity-content';
import type { SessionTerminalUpdate, SessionTerminalChunk } from '../session-protocol';

export type NormalizedToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type NormalizedToolLocation = Pick<ToolCallLocation, 'path' | 'line'>;

export type NormalizedEvent =
  | { kind: 'interrupted_for_message' }
  | { kind: 'prompt_result'; requestId: string; _meta?: Readonly<Record<string, unknown>> | null;
      error?: import('@gugu/session-shared').SerializedError }
  | { kind: 'terminal_update'; terminal: SessionTerminalUpdate }
  | { kind: 'terminal_chunk'; terminal: SessionTerminalChunk }
  | { kind: 'terminal_snapshots'; terminals: readonly TerminalState[] }
  | {
      kind: 'message';
      content?: EntityContent[] | null;
      contentMode?: 'replace' | 'append';
      _meta?: EntityMeta | null;
      role: 'user' | 'assistant';
      /**
       * Provider-assigned message id. Null when the provider omitted it; the reducer
       * synthesizes a stable segment id before folding the transcript item.
       */
      messageId: string | null;
      text: string;
      revertAnchor?: string;
      /** A message that continues the active turn: a cell-inserted one, or a steered input replayed from history. */
      steering?: boolean;
      /** Attachment references for user messages submitted with images. */
      attachments?: AttachmentRef[];
      /** What started the turn this user message opens (ignored on a steering message). */
      trigger?: TranscriptTurnTrigger;
    }
  | {
      kind: 'thinking';
      content?: EntityContent[] | null;
      contentMode?: 'replace' | 'append';
      _meta?: EntityMeta | null;
      messageId: string | null;
      text: string;
    }
  | {
      kind: 'tool_call';
      contentBlocks?: EntityContent[] | null;
      _meta?: EntityMeta | null;
      toolCallId: string;
      title: string;
      /** 供应商自己的工具名,标题是显示名时由 transport decoding 从 vendor `_meta` 提上来(见 BaseToolCallItem)。 */
      toolName?: string;
      /** ACP ToolKind passthrough ('edit', 'execute', 'read', 'think', ...). */
      toolKind: string | null;
      status: NormalizedToolStatus | null;
      /**
       * Parent tool call id for nested subagent invocations.
       * Null in the baseline; providers promote vendor _meta via transport decoding.
       */
      parentToolCallId: string | null;
      locations: NormalizedToolLocation[];
      inputSummary?: string;
      /** Serialized ACP `rawInput` — the arguments handed to the tool. */
      rawInput?: string;
      /** Serialized ACP `rawOutput` — the tool's own return value. */
      rawOutput?: string;
      outputText?: string;
      /** The image blocks of its ACP `content`, as they came (see `ToolImage`). */
      images?: ToolImage[];
      terminalId?: string;
      /**
       * 这次调用**留下了一个还在跑的后台任务**(claude 的 `run_in_background` Bash、
       * workflow),供应商给的任务 id 记在这儿(#5117)。
       *
       * ⚠️ 它与调用本身的 `status` 不是一回事:派发调用在派出去那一刻就 `completed` 了,
       * 后台那件事还在跑 —— 所以「有没有东西还在跑」判不出来,必须由这个字段说。
       * 跑完(或被停)由 `backgroundTaskDone` 落定。
       */
      backgroundTaskId?: string;
      /** 那个后台任务的完成通知到了 —— 它不再在跑(#5117)。 */
      backgroundTaskDone?: true;
      /**
       * How the command's process ended.
       *
       * Absent in the baseline: ACP has no field for it on a tool call — the
       * protocol's own route is a client-owned terminal, which an agent has to
       * ask for. Agents that instead run the command themselves report the exit
       * in vendor `_meta`, and promote it here through transport decoding, exactly the
       * way `parentToolCallId` is promoted.
       */
      exitStatus?: TerminalExit;
    }
  | {
      kind: 'subagent';
      toolCallId: string;
      rawInput?: string;
      rawOutput?: string;
      /**
       * 这个子任务叫什么。**可缺席 —— 缺席 = 保持不变**(与本文件 locations 那条同一个
       * 约定)。
       *
       * ⚠️ 曾经是必填,而必填在这里是有害的:claude 的一次 Task 是四条事件,只有第二条
       * 带真名字,最后一条(完成)`title` 是 null。必填逼得供应商钩子**必须交出点什么**,
       * 于是它编了个 `?? 'Agent'`,fold 再无条件写进条目 ⇒ 真名字被自己盖掉。owner 截图
       * 里那一屏「Agent 已完成」就是这么来的(2026-09-05)。
       *
       * 一个字段没法表达「我这条没带」的时候,填空的那一方只能伪造。
       */
      title?: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      inputSummary?: string;
      background?: boolean;
      agentId?: string;
      /**
       * 谈成 `clientCapabilities.subagents` 之后,这个子智能体**自己就是一个会话**
       * (`subagent_spawned.subagentSessionId`)。没谈成时缺席 —— 那种情况下它的一切都
       * 留在根会话上,压根没有独立身份可填(#5117)。
       *
       * ⚠️ 它与 `agentId` **不是**一回事:`agentId` 是 SDK 任务登记册的键(供应商内部),
       * 这个是 ACP 会话号,是**取消它时要打的那个地址**。❌ 别互相顶替。
       */
      subagentSessionId?: string;
      /**
       * 这个子智能体能不能被取消 —— 来自 `subagent_spawned.capabilities.cancel`,
       * **由 agent 告诉我们**,❌ 不由界面猜。
       *
       * 为什么必须是给定的:0.75.1 的 `_session/async_task/stop` 按设计就停不了子智能体
       * (`isSubagentTask()` 把它标 `ignored`,`canStop` 要求 `!ignored`)⇒ 谁能停、怎么停,
       * 客户端自己推不出来。缺席 = 不知道,按不能停画。
       */
      canCancel?: boolean;
      /**
       * 派它出去的那次 Agent/Task 调用的 tool_use id —— 当这一行的键已经是**会话号**时,
       * 它只是同一个子智能体的**别名**(#5117)。
       *
       * 真机 2026-09-06 原始日志:`subagent_spawned{subagentSessionId:a0fc…}` 之后 1 毫秒,
       * Agent 那次调用的 `tool_call_update` 照样到了,`toolResponse.agentId` 就是同一个
       * `a0fc…`。不认亲的话它会立起第二行,而完成事件只认得其中一行 ——「派出了 2 个、
       * 1 个跑完了」。由 reducer 按登记册回填,❌ 供应商钩子别自己填。
       */
      agentToolUseId?: string;
      /** 它回给主智能体的正文(子会话上流回来的 agent 文本)。缺席 = 保持不变。 */
      outputText?: string;
      /** 这个子 agent 实际跑在哪个模型上 —— 供应商给了才有,❌ 不猜。 */
      model?: string;
      outputFile?: string;
    }
  | {
      kind: 'subagent_update';
      canCancel?: boolean;
      toolCallId?: string;
      agentId?: string;
      /** 会话形态下的身份,见 `subagent` 变体上同名字段。 */
      subagentSessionId?: string;
      status: NormalizedToolStatus;
      summary?: string;
      outputFile?: string;
    }
  | {
      /**
       * 「那个子智能体跑完了」(#4981)。owner 2026-09-06:「子智能体运行完你就当 toolcall
       * 渲染就行了,agent complete 类似于」⇒ 它在转录里是**又一次工具调用**,不是一条消息。
       *
       * ⚠️ 这里先前做成了 `role:'user'` 的消息。后果不是「样式差一点」,是**切轮**:
       * reducer 的 OPEN boundary 就是「新的用户消息开一轮」(见 reducer.ts),于是每来一条
       * 通知就在流式中途把正在写的那条回复当场封口、剩下的字另起一条。owner 真机截图
       * (2026-09-06)里那一屏全是它的派生:「金融业增长 8」⏎「.7%,数字经济…」一个数字
       * 被从中间切开;半截消息底下补出复制按钮和一块留白(封口了就当settled,给页脚);
       * 同一个 `resp_…` 出现在相邻两轮、文字叠字;日期分隔行跟着换轮。
       * ⇒ 这条通知**永远不许长成 user 消息**。
       */
      kind: 'subagent_done';
      /** 派它出去的那次调用 —— 面板据此知道哪张卡该撤。 */
      toolCallId: string;
      agentId: string;
      /** 会话形态下的身份,见 `subagent` 变体上同名字段。 */
      subagentSessionId?: string;
      /**
       * `stopped` = 被叫停(卡上的「停止」或供应商自己停的,#5117),与跑成/跑砸并列。
       *
       * `disconnected` = **失联**:协议里 `subagent_state_update` 的第四态。它既不是跑成
       * 也不是跑砸,而是「我们和它断了,它现在是死是活我们不知道」—— 重连/resume 之后最常见。
       * ⚠️ ❌ 别把它折进 `failed`:那是把「不知道」写成「知道它砸了」,而这两件事对用户
       * 该做的动作不同(失联该给重连/去看输出文件,砸了该给报错)。
       */
      status: NormalizedToolStatus | 'stopped' | 'disconnected';
      /** 供应商给的一句话总结,可能没有。 */
      summary?: string;
      /** 它的输出落在哪个文件里,可能没有。 */
      outputFile?: string;
      /**
       * 它叫什么。⚠️ **由 reducer 填**,按 `toolCallId` 从 agents 登记册里查 —— 通知本身
       * 不带名字,只有 `Agent "X" finished` 那句英文散文,❌ 不去解析散文反推名字。
       * 查不到就留空,行上落到通用词。
       */
      name?: string;
      /**
       * 它回给主智能体的正文。同样**由 reducer 填**(登记册 `output`,由子会话流累计,#5117);
       * 通知本身不带正文。这一行是「它跑完了」这次调用,正文就是这次调用的结果。
       */
      outputText?: string;
    }
  | {
      /**
       * 一个**后台任务**开跑了(`async_task_spawned`,#5117)。
       *
       * ⚠️ 它和 `subagent` 是**两种东西**,别合并:后台任务是「跑一条命令」,子智能体是
       * 「派一个人」。协议也把它们分在两条 lane 上,连取消的方法都不同(见 `canStop`)。
       */
      kind: 'async_task';
      asyncTaskId: string;
      name: string;
      /** 供应商给的任务类型(如 Bash)。原样透传,❌ 不在这里翻译成给人看的词。 */
      taskType: string;
      description: string;
      /**
       * agent 认为这条该不该出现在转录里。**由 agent 说了算**,❌ 界面别自己决定 ——
       * 同一条任务在面板里始终可见,在转录里露不露是另一回事。
       */
      showInTranscript: boolean;
      /**
       * 能不能停。**给定的**,不是推的。
       *
       * ⚠️ 子智能体派生的任务这里会是 `false` —— 0.75.1 的 `isSubagentTask()` 把它们标
       * `ignored`,`_session/async_task/stop` 对它们恒返回 `{stopped:false}`。
       * ⇒ 界面必须照这一格画停止按钮,否则就是给用户一个按了没反应的按钮。
       */
      canStop: boolean;
      /** 输出落在哪个文件。**可能 spawn 时还没有,后续 progress/state 补齐。** */
      outputFilePath?: string;
      /**
       * 派它出去的那次工具调用。
       *
       * ⚠️ **可能迟到**:协议原文 “Originating tool call, when correlation becomes known
       * after spawn.” ⇒ 缺席 = **还不知道**,❌ 不是「没有父调用」。按「没有」处理会把它
       * 错画成一条顶层任务 —— 这正是 #5117 里那条凭空多出来的行。
       */
      toolCallId?: string;
    }
  | {
      /** 后台任务的实时进度(`async_task_progress`)。 */
      kind: 'async_task_progress';
      asyncTaskId: string;
      description?: string;
      summary?: string;
      lastToolName?: string;
      usage?: { totalTokens: number; toolUses: number; durationMs: number };
      /** 迟到补齐,语义同 `async_task` 上的同名字段。 */
      outputFilePath?: string;
      toolCallId?: string;
    }
  | {
      /** 后台任务的状态迁移(`async_task_state_update`)。 */
      kind: 'async_task_state';
      asyncTaskId: string;
      /**
       * `paused` 是协议里有、我们此前完全没有的一态 —— ❌ 别折进 running 或 stopped。
       */
      state: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
      summary?: string;
      /** 终态才补上的日志路径也走这里。 */
      outputFilePath?: string;
      toolCallId?: string;
    }
  | {
      /**
       * 子智能体**自己会话**上流过来的一条事件(#5117)。
       *
       * 谈成 `clientCapabilities.subagents` 后,子智能体的输出**改写了 sessionId** 发在它
       * 自己的会话上(0.75.1 `native-subagents.route()`:`{...notification, sessionId:
       * child.sessionId}`)。runtime 按会话号认出它是谁家的孩子,裹上这层再交给 reducer:
       * 归属是**显式的**,❌ 不靠 reducer 猜「这条像不像子智能体的」。
       *
       * 2026-09-06 真机:子智能体回传的那句话就发在会话 `a0fc…` 上,路由表不认识,整条
       * 丢弃 —— owner 说的「消息丢了」。
       */
      kind: 'subagent_stream';
      subagentSessionId: string;
      event: NormalizedEvent;
    }
  | {
      /**
       * 一条后台命令跑完了(#5117)。**reducer 内部**从后台任务的终态派生,❌ 供应商钩子不产出。
       *
       * owner 2026-09-07:「命令完成没有提示啊,agent 运行完都有提示,他没有」—— 与子智能体
       * 同一模型:派发一行、跑完另一行,两行都是工具调用(`subagent_done` 那条的镜像)。
       */
      kind: 'background_command_done';
      /** 起它那次调用(命令卡)的 toolCallId。 */
      toolCallId: string;
      /** 那条命令(卡的标题);一个字都没有就空串,行上落到通用词,❌ 不编。 */
      name: string;
      outcome: 'completed' | 'failed' | 'stopped';
      summary?: string;
    }
  | {
      kind: 'search';
      toolCallId: string;
      query: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      matchCount?: number;
    }
  | {
      kind: 'mcp_tool';
      toolCallId: string;
      server?: string;
      tool: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
      inputSummary?: string;
    }
  | {
      kind: 'web_fetch';
      toolCallId: string;
      url: string;
      title?: string;
      status: NormalizedToolStatus | null;
      parentToolCallId: string | null;
    }
  | {
      kind: 'tool_update';
      contentBlocks?: EntityContent[] | null;
      contentMode?: 'replace' | 'append';
      _meta?: EntityMeta | null;
      /** Native result contained a completed, nonempty answer map before display formatting. */
      recordedAnswers?: boolean;
      toolCallId: string;
      title?: string | null;
      /** 同 tool_call 的 `toolName`。 */
      toolName?: string | null;
      toolKind?: string | null;
      status?: NormalizedToolStatus | null;
      parentToolCallId?: string | null;
      /** Undefined leaves the prior collection unchanged; null or [] clears it. */
      locations?: NormalizedToolLocation[] | null;
      outputText?: string | null;
      /** As on `tool_call`; undefined leaves the prior pictures unchanged. */
      images?: ToolImage[] | null;
      /** Serialized ACP `rawInput` — the arguments handed to the tool. */
      rawInput?: string | null;
      inputSummary?: string | null;
      /** Serialized ACP `rawOutput` — the tool's own return value. */
      rawOutput?: string | null;
      terminalId?: string | null;
      /**
       * How the command's process ended.
       *
       * Absent in the baseline: ACP has no field for it on a tool call — the
       * protocol's own route is a client-owned terminal, which an agent has to
       * ask for. Agents that instead run the command themselves report the exit
       * in vendor `_meta`, and promote it here through transport decoding, exactly the
       * way `parentToolCallId` is promoted.
       */
      /**
       * 这次调用**留下了一个还在跑的后台任务**(claude 的 `run_in_background` Bash),
       * 供应商给的任务 id(#5117)。⚠️ 与调用自己的 `status` 不是一回事:派发调用在派出去
       * 那一刻就完成了,后台那件事还在跑 —— 只看 status 判不出「有没有东西还在跑」。
       */
      backgroundTaskId?: string;
      /** 那个后台任务的完成通知到了 —— 它不再在跑(#5117)。 */
      backgroundTaskDone?: true;
      exitStatus?: TerminalExit;
    }
  | {
      kind: 'plan';
      planId?: string;
      body?: EntityContent;
      _meta?: EntityMeta | null;
      entries: PlanEntryInput[];
    }
  | { kind: 'plan_remove'; planId: string }
  | {
      /** Full config option array from config_option_update. */
      kind: 'config';
      options: ReadonlyArray<SessionConfigOption>;
    }
  | {
      /** Selected mode id from current_mode_update. */
      kind: 'mode_selected';
      modeId: string;
    }
  | {
      /**
       * ACP **稳定版** `modes` 字段({currentModeId, availableModes})的载体 —— session/new 与
       * session/load 的回包都带它。与 `config`(unstable `configOptions`)是两条互相独立的来源:
       * 只报稳定版的家(gemini)此前根本没有任何事件能把可用档位送进 SessionConfigState,
       * `modeOptions` 恒 null ⇒ 权限档 UI 空、`applyConfiguredPermissionMode` 直接抛(#4655)。
       * reducer 侧的让位规则:`config` 携带的 mode 组(带真 configId)始终赢,本事件只补空位。
       */
      kind: 'modes_state';
      currentModeId: string | null;
      /** 字段形状对齐 SDK 的 SessionMode(`description?: string | null`),reducer 侧收敛 null。 */
      availableModes: ReadonlyArray<{ id: string; name: string; description?: string | null }>;
    }
  | {
      /** Full available command list from available_commands_update. */
      kind: 'commands';
      commands: ReadonlyArray<SessionCommandDefinition>;
    }
  | {
      /** Usage figures from usage_update. */
      kind: 'usage';
      usage: SessionUsage;
    }
  | {
      /** Session title from session_info_update. */
      kind: 'title';
      title: string;
    }
  | {
      /**
       * 一次上下文压缩的边界。两条来源都收敛到这一个事件上（见 `decode.ts` 的
       * `decodeCompactionSessionUpdate`）：
       *
       * ① 适配器在 tool call 上挂的 `_meta.contextCompaction` —— 今天实际在走的那条。
       * ② ACP `session-compaction` RFD 的 `compaction_update` —— 还没有一家发，接着等。
       *
       * 下面那几个数只有 ① 给得出：RFD 那条只报边界和摘要。所以**每一个都是可选的**，
       * ❌ 别让画面依赖它们存在。
       */
      kind: 'compaction';
      compactionId: string;
      /**
       * 缺席 = 这条更新**没说**状态(适配器的补数更新),❌ 不是「在压」。
       * fold 据此保留行上原来的状态;只有新立的行才默认 in_progress。
       */
      status?: 'in_progress' | 'completed' | 'failed';
      /** `completed` 时给出的完整摘要；缺席表示这次压缩不带摘要。 */
      summary?: string;
      /** 是用户自己敲的 `/compact`，还是撞到窗口自动压的。 */
      trigger?: 'manual' | 'automatic';
      /** 压之前 / 压之后的 token 数：这两个数才说明"丢了多少原文"。 */
      preTokens?: number;
      postTokens?: number;
      durationMs?: number;
      /** 压缩失败时的原因；有它就一定是 `failed`。 */
      error?: string;
    }
  | {
      /** 流式补齐的摘要片段（`compaction_summary_chunk`），按 `compactionId` 归到同一行。 */
      kind: 'compaction_summary_chunk';
      compactionId: string;
      text: string;
    }
  | {
      /**
       * 引擎接不上这条会话、已经替它开了一条新的（`session/load` 失败后的降级）。
       *
       * ⚠️ 这一条**不来自协议**，是运行时自己合成的:只有我们知道刚才那次 load 没成。
       * 与 `background_command_done` 同一类合成事件。
       */
      kind: 'context_reset';
      reason: string;
    }
  | {
      /**
       * 这条会话的运行条件出了事，但会话照常开（spec `session-always-openable`）。
       *
       * ⚠️ 同样**不来自协议**，是运行时自己合成的:只有我们知道刚才那次配置没落下去。
       * 与 `context_reset` 同一类合成事件 —— 区别是那条说「agent 手里没有上文」，
       * 这条说「上文没问题，是跑它的条件变了」。
       * 例外是 `provider-notice`:它来自协议的 `notice`,是供应商告诉用户的一件事,❌ 不是 agent 说的话。
       */
      kind: 'session_notice';
      code: SessionNoticeCode;
      detail: string;
      effectiveValue?: string;
      previousValue?: string;
      /** 只有 `provider-notice` 带:供应商 `notice` 的 title。 */
      title?: string;
    }
  | {
      /**
       * agent 自己报的状态(ACP v2 草案 `state_update`):在干活 / 等人 / 空闲。
       * ⚠️ 不是转录里的东西,也不属于哪一轮:谁开的工都一样 —— cell 拿它判「在不在跑」,别处不碰。
       */
      kind: 'agent_state';
      summary?: string;
    } & import('../session-protocol').SessionForegroundState
  | {
      /**
       * harness 自己报的这条会话记录的路径(Claude:桥接把 SDK hook 的 `transcript_path` 转来)。包装器在进程里设的配置目录
       * 只有它知道;宿主据此认会话记录在哪(harness-config-roots)。不进转录。
       */
      kind: 'transcript_path';
      path: string;
    }
  | { kind: 'ignored' };
