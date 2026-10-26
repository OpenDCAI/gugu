import type { PromptResponse, SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent, NormalizedToolStatus, SessionUsage } from '@gugu/session-core/acp';
import { redactAll } from '@gugu/session-shared/logger';
import { terminalExitFromMeta } from '../../acp-terminal-exit';

/**
 * Claude-specific enrichment of a baseline `NormalizedEvent`.
 *
 * The Claude ACP adapter stamps subagent child updates with
 * `_meta.claudeCode.parentToolUseId` to indicate that a tool call was produced
 * by a nested agent (Task/Agent tool). This function promotes that value to the
 * first-class `parentToolCallId` field so downstream consumers never need to
 * know about `claudeCode`.
 *
 * Returns the original update object unchanged when:
 * - The update is not a `tool_call` or `tool_update`.
 * - The vendor field is absent or not a string.
 */
export function enrichClaudeUpdate(update: NormalizedEvent, raw: SessionUpdate): NormalizedEvent {
  const failure = claudeSessionFailure(raw._meta);
  if (failure?.severity === 'warning') {
    const title = redactAll(failure.title);
    return { kind: 'session_notice', code: 'provider-notice', title, detail: redactAll(failure.details ?? failure.title) };
  }
  if (update.kind === 'message' && update.role === 'user') {
    const text = update.text.trim();
    if (isLocalCommandChunk(text)) return { kind: 'ignored' };
    const notification = parseTaskNotification(text);
    if (notification) {
      // owner 2026-09-06:「子智能体运行完你就当 toolcall 渲染就行了,agent complete 类似于」。
      // ⇒ 它在转录里是**又一次工具调用**,与派发那一行走同一套渲染。
      //
      // ⚠️ ❌ 绝不能再当 `role:'user'` 的消息发下去。供应商是把它当用户消息注进会话的,
      // 照单全收看着自然,而 reducer 的开轮边界正是「新的用户消息开一轮」—— 于是每来一条
      // 通知就在**流式中途**把正在写的那条回复当场封口。owner 2026-09-06 真机截图:
      // 「金融业增长 8」⏎「.7%,数字经济…」,一个数字被从中间切开。
      return {
        kind: 'subagent_done',
        // 同一个任务会来不止一条通知,后来的那条可能不带 tool-use-id(2026-09-06 引擎日志实测):
        // 那就用 taskId 顶上,reducer 按登记册里的 agentId 对得上、再归一到派发那次调用。
        toolCallId: notification.toolUseId ?? notification.taskId,
        agentId: notification.taskId,
        status: notification.status,
        ...(notification.summary !== undefined ? { summary: notification.summary } : {}),
        ...(notification.outputFile !== undefined ? { outputFile: notification.outputFile } : {}),
      };
    }
    // 子智能体给父会话发的话(`Another Claude session sent a message:` + `<agent-message>`)。
    // 供应商 live 时根本不发它(字符串形态的 user 消息在适配器里被跳过),只有 replay 会
    // 把它当 user_message_chunk 吐出来 —— 那它就会开一轮、钉在顶上、还能被「取回指令」
    // 塞进输入框。owner 2026-09-06:「别的 agent 给这个 agent 发的信息其实也是通知,
    // 不应该计入消息」。⇒ 与 live 同一个样子:不进转录。
    if (isPeerAgentMessage(text)) return { kind: 'ignored' };
    return update;
  }

  // 「那个子智能体跑完了」的 **live** 形态(#4981)。SDK 把它作为 `system/task_notification`
  // 事件发出来,适配器(0.75.1)只在客户端声明 JetBrains AIR 能力时才发任务生命周期、且那条路
  // 把子智能体整个忽略;仓里的 patch(patches/@agentclientprotocol__claude-agent-acp)
  // 把它转成一条只带 `_meta.claudeCode.taskNotification` 的 tool_call_update 转发过来。
  // 没有这一路,live 时登记册里那个后台子智能体永远 running ⇒ 会话永远「工作中」。
  // 「这次调用留下了一个还在跑的后台任务」的 live 形态(#5117)。主智能体自己起的后台命令
  // (`run_in_background` 的 Bash)与子智能体不同:**它不挂住这一轮** —— 轮收口了、进程还在跑,
  // 而客户端此前对它一无所知,于是屏幕上没有任何可停的东西(2026-09-06 实测:`sleep 3000`
  // 在轮结束后仍活着)。仓里的 patch 把 SDK 的 `task_started` 转成一条只带
  // `_meta.claudeCode.taskStarted` 的 tool_call_update 转发过来,这里把任务 id 记到那次调用上。
  // 子智能体不走这条:它们的派发调用本身就是一张卡。
  if (update.kind === 'tool_update') {
    const started = readTaskStartedMeta(raw);
    if (started) {
      return {
        kind: 'tool_update',
        toolCallId: started.toolUseId ?? started.taskId,
        // 全 null = 只补字段,不动这次调用的名字/状态/归属(它在派出去那一刻就完成了)。
        title: null,
        toolKind: null,
        status: null,
        parentToolCallId: null,
        diffs: [],
        backgroundTaskId: started.taskId,
      };
    }
  }

  if (update.kind === 'tool_update') {
    const live = readTaskNotificationMeta(raw);
    if (live) {
      return {
        kind: 'subagent_done',
        toolCallId: live.toolUseId ?? live.taskId,
        agentId: live.taskId,
        status: toNotificationStatus(live.status),
        ...(live.summary !== undefined ? { summary: live.summary } : {}),
        ...(live.outputFile !== undefined ? { outputFile: live.outputFile } : {}),
      };
    }
  }

  // 桥接在 Claude 确认上下文窗口之前报的 `size` 是按模型名猜的(Opus 5.5 原生 1M,名字里没有
  // 「1m」⇒ 猜成 200k),它把这种读数标成 `_claude/contextWindowEstimated`(#6552)。
  // ACP 要求 `size` 是个数,所以桥接只能标、不能不给;这里把猜的上限换成「未知」(0),
  // composer 就不画上限 —— ❌ 不把一个猜的数当成这条会话的上限给人看。
  // G3: the account's limit rides a usage update as `_claude/rateLimit` (the SDK's `rate_limit_event`); it is taken into
  // the neutral `usage.rateLimit` — the Apps that read agents read it there — and the rest of it stays behind.
  if (update.kind === 'usage') {
    const rateLimit = claudeRateLimit(raw);
    const estimated = isEstimatedContextWindow(raw);
    if (!rateLimit && !estimated) return update;
    const usage = { ...update.usage, ...(estimated ? { contextSize: 0 } : {}) };
    return { ...update, usage: rateLimit ? { ...usage, rateLimit } : usage };
  }

  if (update.kind !== 'tool_call' && update.kind !== 'tool_update') return update;

  const parentToolUseId = (
    raw._meta as { claudeCode?: { parentToolUseId?: unknown } } | null | undefined
  )?.claudeCode?.parentToolUseId;

  const parentPatch =
    typeof parentToolUseId === 'string' ? { parentToolCallId: parentToolUseId } : {};
  const outputPatch =
    update.outputText === undefined && rawOutputText(raw) !== undefined
      ? { outputText: rawOutputText(raw)! }
      : {};

  // 派出去之后再对**同一个 worker** 做的事:收它的输出、把它停掉。它们不是新的一次
  // 派活 —— 卡组里那张卡就是它们说的那个 worker,所以不另起一行。
  // (与 codex 那边 `wait` / `closeAgent` 同一条口径。)
  if (isSubagentBookkeepingToolName(claudeToolName(raw))) {
    // 收割那一步**不出行**(它是簿记),但它带回来的东西不能扔:结果里写着被收割的那个
    // 子智能体此刻是什么状态 —— 这是同一轮里唯一一个说得准的完成信号。
    const harvested = parseHarvestedTask(raw);
    if (harvested) {
      return { kind: 'subagent_update', agentId: harvested.agentId, status: harvested.status };
    }
    return { kind: 'ignored' };
  }

  if (isSubagentToolName(claudeToolName(raw))) {
    const asyncLaunch = parseAsyncLaunch(raw);
    // ⚠️ 模型名**不在**异步派发那一支里读。真机 2026-09-05 的会话 JSONL:一次普通
    // (非 async)派发的 toolUseResult 是
    //   {"status":"completed","agentId":"a620e…","resolvedModel":"gpt-5.6-terra",…}
    // —— 没有 `isAsync`、`status` 也不是 `async_launched`,于是 `parseAsyncLaunch`
    // 返回 null,模型名整个被丢掉,卡上那一格常年空着。⇒ 单独读,与 async 无关。
    const resolvedModel = parseResolvedModel(raw) ?? asyncLaunch?.model;
    // 这条事件带来的名字。⚠️ 拿不到就**不交**,❌ 别再 `?? 'Agent'` 兜底 ——
    // 一次 Task 是四条事件,只有第二条带真名字(`统计 Markdown 文件数`),最后那条
    // `title` 是 null。兜底出来的占位词会顺着 fold 把真名字盖掉,行上就只剩
    // 一屏「Agent 已完成」(owner 真机 2026-09-05)。缺席 = 保持不变。
    // ⚠️ 供应商在描述还没到的时候会把**原始工具名**填进 title(实测 toolName=`Agent`
    // 而 title=`Task`)。那不是名字,是函数名 —— 印出来就是 owner 2026-09-06 截图里
    // 那三张只写着「Task」的卡。⇒ 与「这是不是一次子智能体派发」用同一张表判:
    // 那张表认得的词,就是工具名,不是描述。判不出名字就**不交**,由行/卡各自落到
    // 通用词,❌ 别把函数名当名字印给人看。
    const rawTitle = update.title ?? undefined;
    const title =
      asyncLaunch?.description ?? (isSubagentToolName(rawTitle ?? null) ? undefined : rawTitle);
    return {
      kind: 'subagent',
      toolCallId: update.toolCallId,
      ...(title !== undefined ? { title } : {}),
      // ⚠️ 异步派发照供应商说的算,❌ 别改写成「还在跑」。
      //
      // 派发**这件事**在启动返回的那一刻就完成了 —— 供应商也正是这么报的。先前这里把它
      // 强行按成 `in_progress`,是想让转录那一行一直「活着」,好在子智能体真跑完时再去
      // 把它改成完成。owner 2026-09-06 判掉了这条路:「这里不该是个运行中,因为再去把
      // 运行中的组件在合适的时候去更新状态到完成是有点难的…其实无非是 toolcall 和
      // notification,这样工具调用的渲染才能统一」。
      //
      // 于是模型是两件普通的事:**一次当场完成的工具调用**(启动子智能体),
      // 之后**一条通知**(它跑完了)。没有需要谁记得在某个时刻去落定的活组件 ——
      // 先前那一整类毛病(永远显示运行中、失败重派后旧卡撤不掉、进度条恒满时长恒 0)
      // 根子都在这一行。
      //
      // 「它还在不在跑」由 agents 登记册回答(`updateAgentSlice`),那一片只被真信号推动
      // (完成通知 / SessionOutput 收割),与转录行的状态是两回事。
      //
      // ⚠️ 谈成 `clientCapabilities.subagents` 后,这条 `tool_call_update` 只带 `toolResponse`
      // 不带 `status`(2026-09-06 原始日志第 5 条)。启动**已经返回**了(`status:
      // "async_launched"`)⇒ 按上面那条口径,派发这次调用就是完成了;供应商没写字段,
      // 不等于它没说 —— 它在 toolResponse 里说了。
      status: update.status ?? (asyncLaunch ? 'completed' : null),
      parentToolCallId: parentPatch.parentToolCallId ?? update.parentToolCallId,
      inputSummary: agentInputSummary(raw),
      ...(update.rawInput !== undefined ? { rawInput: update.rawInput } : {}),
      ...(update.rawOutput !== undefined ? { rawOutput: update.rawOutput } : {}),
      ...(update.outputText !== undefined ? { outputText: update.outputText } : outputPatch),
      ...(asyncLaunch ? { background: true } : {}),
      ...(asyncLaunch?.agentId !== undefined ? { agentId: asyncLaunch.agentId } : {}),
      ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
      ...(asyncLaunch?.outputFile !== undefined ? { outputFile: asyncLaunch.outputFile } : {}),
    };
  }

  // The adapter runs Bash itself rather than asking the client for a terminal, so
  // this `_meta` block is the only place the command's exit is reported at all.
  const exitStatus = terminalExitFromMeta(raw);
  const exitPatch = exitStatus === undefined ? {} : { exitStatus };
  // 工具名:适配器的标题常是给人看的(计划批准叫「Approve Plan」),真名只在 `_meta` 里 ——
  // 不提上来,认「这是不是问用户的那次调用」的地方(折叠、权限请求在等什么)就认不出来。
  const toolName = claudeToolName(raw);
  const namePatch = toolName === null ? {} : { toolName };

  if (
    !parentPatch.parentToolCallId &&
    outputPatch.outputText === undefined &&
    exitPatch.exitStatus === undefined &&
    namePatch.toolName === undefined
  ) {
    return update;
  }
  return { ...update, ...parentPatch, ...outputPatch, ...exitPatch, ...namePatch };
}

/** The bridge reports terminal failures on the prompt response, including v2's idle metadata. */
export function claudePromptFailure(response: PromptResponse): string | null {
  const failure = claudeSessionFailure(response._meta);
  if (failure?.severity !== 'error') return null;
  return redactAll([failure.title, failure.details].filter(Boolean).join('\n'));
}

function claudeSessionFailure(meta: unknown): { title: string; severity: string; details?: string } | null {
  const failure = (meta as { jetbrains?: { air?: { sessionFailure?: Record<string, unknown> } } } | null)?.jetbrains?.air?.sessionFailure;
  if (!failure || typeof failure.title !== 'string' || typeof failure.severity !== 'string') return null;
  return { title: failure.title, severity: failure.severity, ...(typeof failure.details === 'string' ? { details: failure.details } : {}) };
}

type ClaudeMeta = {
  claudeCode?: {
    parentToolUseId?: unknown;
    toolName?: unknown;
    toolResponse?: unknown;
  };
};

type AsyncLaunch = {
  agentId: string;
  outputFile?: string;
  description?: string;
  /** 派出去之后真正解析到的模型名(`resolvedModel`),用来画卡上的模型片。 */
  model?: string;
};

type TaskNotification = {
  taskId: string;
  /** 缺席 = 供应商这一条没带(同一任务的后续通知常常不带)。 */
  toolUseId?: string;
  outputFile?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'stopped';
  summary?: string;
};

function claudeMeta(raw: SessionUpdate): ClaudeMeta['claudeCode'] | undefined {
  return (raw._meta as ClaudeMeta | null | undefined)?.claudeCode;
}

/**
 * claude 派子任务的那个工具**有两个名字**,同一个适配器版本(0.54.1)下都出现过:
 *
 *   · `Agent` —— owner 那台验收实例的真流(会话 JSONL 里 tool_use 的 name);
 *   · `Task`  —— 我在 MBP 上现录的一份(`tooling/fixtures` 录制,2026-09-05)。
 *
 * 只认前者的话,后一种整批掉进 `unknown-tool-call`:三个子任务在行上变成三条
 * 「工具 · 统计 HTML 文件数量」,子智能体那一族的画法(状态点、子项、派活描述)
 * 完全用不上。⚠️ 这条**按名字**认,而名字是上游随版本会变的东西 —— 判据里两个
 * 名字都钉着,配阴控挡住别的工具。
 */
function isSubagentToolName(toolName: string | null): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}

/**
 * 派活之后针对同一个 worker 的事务性调用。
 *
 * 适配器把 `TaskCreate/TaskUpdate/TaskList/TaskGet`(待办清单那一族)自己压掉了,
 * 却漏了收割与停止这两个 —— 它们于是掉进 `unknown-tool-call`,行上写成
 * 「工具 · SessionOutput  task_id: a6519fe00fdb88a3e block: true timeout: 30000」
 * (owner 真机 2026-09-05 那一轮)。**内部 id 不是给人看的**,与 agentId 那条同源。
 *
 * ⚠️ 这不是兜底:按名字认,认不出的照旧落 unknown 响亮地露出来。
 */
function isSubagentBookkeepingToolName(toolName: string | null): boolean {
  return toolName === 'TaskOutput' || toolName === 'TaskStop';
}

function claudeToolName(raw: SessionUpdate): string | null {
  const toolName = claudeMeta(raw)?.toolName;
  return typeof toolName === 'string' ? toolName : null;
}

function agentInputSummary(raw: SessionUpdate): string | undefined {
  const input = (raw as { rawInput?: { description?: unknown } }).rawInput;
  return typeof input?.description === 'string' ? input.description : undefined;
}

/**
 * 这个 worker 实际跑在哪个模型上 —— claude 在**每一次**派发的工具结果里都报
 * (`toolResponse.resolvedModel`),与是不是异步派发无关。
 */
function parseResolvedModel(raw: SessionUpdate): string | undefined {
  const response = claudeMeta(raw)?.toolResponse as { resolvedModel?: unknown } | null | undefined;
  return typeof response?.resolvedModel === 'string' ? response.resolvedModel : undefined;
}

/**
 * 收割结果里那个子智能体此刻的状态。
 *
 * owner 2026-09-06:「怎么还是显示运行中,但是我看结果好像都跑完了…这些智能体一直阻塞
 * 在这至少视觉上没有回收了」。
 *
 * 病根不在显示,在信号:后台子智能体跑完的通知(`<task-notification>`)**只在下一个回合
 * 开始时才送达** —— 这一轮说完话就没有下一轮,通知永远不来,那一行于是一直挂着「运行中」。
 * 而同一轮里其实有个说得准的信号:主智能体自己会用 `SessionOutput` 去收割,收割结果里
 * 明写着 `task.task_id` 与 `task.status`。实机 2026-09-06 抓到的原文:
 *
 *   {"retrieval_status":"timeout",
 *    "task":{"task_id":"a23148fe34f51cc7b","task_type":"local_agent","status":"running",…}}
 *
 * ⇒ 收割那一步照旧**不出行**(它是簿记,owner 早先要求压掉),但它报的状态要接回来。
 *
 * ⚠️ 读的是 `task.status`,**不是** `retrieval_status`:后者说的是「这次取有没有取到」
 * (上面那条就是 `timeout` 却 `status: running` —— 没取到,人还在跑)。把两者混起来会
 * 在每次收割超时的时候把一个还在干活的智能体判成完了。
 */
function parseHarvestedTask(
  raw: SessionUpdate
): { agentId: string; status: NormalizedToolStatus } | null {
  const task = (
    claudeMeta(raw)?.toolResponse as { task?: { task_id?: unknown; status?: unknown } } | null | undefined
  )?.task;
  const agentId = task?.task_id;
  if (typeof agentId !== 'string' || agentId === '') return null;
  switch (task?.status) {
    case 'completed':
      return { agentId, status: 'completed' };
    case 'failed':
      return { agentId, status: 'failed' };
    // 还在跑、或供应商报了个我们不认识的词 —— ❌ 不猜,当作「还在跑」原样交出去。
    default:
      return { agentId, status: 'in_progress' };
  }
}

function parseAsyncLaunch(raw: SessionUpdate): AsyncLaunch | null {
  const response = claudeMeta(raw)?.toolResponse as
    | {
        isAsync?: unknown;
        status?: unknown;
        agentId?: unknown;
        outputFile?: unknown;
        description?: unknown;
        resolvedModel?: unknown;
      }
    | null
    | undefined;
  if (
    response?.isAsync === true &&
    response.status === 'async_launched' &&
    typeof response.agentId === 'string'
  ) {
    return {
      agentId: response.agentId,
      ...(typeof response.outputFile === 'string' ? { outputFile: response.outputFile } : {}),
      ...(typeof response.description === 'string' ? { description: response.description } : {}),
      ...(typeof response.resolvedModel === 'string' ? { model: response.resolvedModel } : {}),
    };
  }

  const text = rawText(raw);
  if (!text.includes('Async agent launched successfully.')) return null;
  const agentId = /^agentId:\s+([^\s]+)/m.exec(text)?.[1];
  if (!agentId) return null;
  const outputFile = /^output_file:\s+(.+)$/m.exec(text)?.[1]?.trim();
  return {
    agentId,
    ...(outputFile ? { outputFile } : {}),
  };
}

function rawText(raw: SessionUpdate): string {
  const parts: string[] = [];
  const content = (raw as { content?: unknown; rawOutput?: unknown }).content;
  collectText(content, parts);
  collectText((raw as { rawOutput?: unknown }).rawOutput, parts);
  return parts.join('\n');
}

function rawOutputText(raw: SessionUpdate): string | undefined {
  const rawOutput = (raw as { rawOutput?: unknown }).rawOutput;
  return typeof rawOutput === 'string' && rawOutput.length > 0 ? rawOutput : undefined;
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, parts);
    return;
  }
  const maybeText = (value as { text?: unknown }).text;
  if (typeof maybeText === 'string') parts.push(maybeText);
  collectText((value as { content?: unknown }).content, parts);
}

function isLocalCommandChunk(text: string): boolean {
  return text.startsWith('<local-command-') || text.includes('<command-name>');
}

/** 真机 2026-09-06 的会话 JSONL:`Another Claude session sent a message:\n<agent-message from="…">…`。 */
function isPeerAgentMessage(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('Another Claude session sent a message:') && head.includes('<agent-message');
}

type LiveTaskNotification = {
  taskId: string;
  toolUseId?: string;
  status: string | null;
  summary?: string;
  outputFile?: string;
};

/** 仓里 patch 过的适配器塞进 `_meta.claudeCode.taskStarted` 的那一坨(#5117)。 */
function readTaskStartedMeta(raw: SessionUpdate): { taskId: string; toolUseId?: string } | null {
  const meta = (raw._meta as { claudeCode?: { taskStarted?: unknown } } | null | undefined)
    ?.claudeCode?.taskStarted;
  if (meta === null || typeof meta !== 'object') return null;
  const record = meta as { taskId?: unknown; toolUseId?: unknown };
  if (typeof record.taskId !== 'string') return null;
  return {
    taskId: record.taskId,
    ...(typeof record.toolUseId === 'string' ? { toolUseId: record.toolUseId } : {}),
  };
}

/** 仓里 patch 过的适配器塞进 `_meta.claudeCode.taskNotification` 的那一坨(字段名照 SDK 的 camelCase 版)。 */
function readTaskNotificationMeta(raw: SessionUpdate): LiveTaskNotification | null {
  const meta = (raw._meta as { claudeCode?: { taskNotification?: unknown } } | null | undefined)
    ?.claudeCode?.taskNotification;
  if (!meta || typeof meta !== 'object') return null;
  const record = meta as Record<string, unknown>;
  if (typeof record.taskId !== 'string' || record.taskId.length === 0) return null;
  return {
    taskId: record.taskId,
    ...(typeof record.toolUseId === 'string' && record.toolUseId ? { toolUseId: record.toolUseId } : {}),
    status: typeof record.status === 'string' ? record.status : null,
    ...(typeof record.summary === 'string' && record.summary ? { summary: record.summary } : {}),
    ...(typeof record.outputFile === 'string' && record.outputFile ? { outputFile: record.outputFile } : {}),
  };
}

export function parseTaskNotification(text: string): TaskNotification | null {
  if (!text.trimStart().startsWith('<task-notification>')) return null;
  const taskId = getTag(text, 'task-id');
  const toolUseId = getTag(text, 'tool-use-id');
  // ⚠️ 只要 task-id。先前要求 tool-use-id 也在,而供应商对同一任务的后续通知不带它 ⇒ 那条
  // 解析失败、按普通用户消息落进转录,正文是一段标签,markdown 渲染成空 —— owner 2026-09-06
  // 截图里回复下面那张空白用户卡就是它。
  if (!taskId) return null;
  return {
    taskId,
    ...(toolUseId ? { toolUseId } : {}),
    status: toNotificationStatus(getTag(text, 'status')),
    ...(getTag(text, 'output-file') ? { outputFile: getTag(text, 'output-file')! } : {}),
    ...(getTag(text, 'summary') ? { summary: getTag(text, 'summary')! } : {}),
  };
}

function getTag(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim() ?? null;
}

function toNotificationStatus(
  status: string | null
): 'pending' | 'in_progress' | 'completed' | 'failed' | 'stopped' {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    // 被叫停(卡上的「停止」→ SDK stop_task,#5117)。SDK 的 typings 说这里是 `stopped`,
    // 而 CLI 2.1.259 真机写的是 `killed`(2026-09-06 实测,`<status>killed</status>`,summary
    // 「was stopped by user」);上游适配器自己的 sessionState 也把 killed / cancelled / stopped
    // 三个词都收成 stopped。三个都认,❌ 只认文档那个。
    case 'stopped':
    case 'killed':
    case 'cancelled':
      return 'stopped';
    case 'pending':
      return 'pending';
    default:
      return 'in_progress';
  }
}

function isEstimatedContextWindow(raw: SessionUpdate): boolean {
  const meta = (raw as { _meta?: Record<string, unknown> | null })._meta;
  return meta?.['_claude/contextWindowEstimated'] === true;
}

/** The limit this update carries, or null (Claude's `resetsAt` is Unix seconds: its `unified-reset` header). */
function claudeRateLimit(raw: SessionUpdate): SessionUsage['rateLimit'] {
  const meta = (raw as { _meta?: Record<string, unknown> | null })._meta;
  const info = meta?.['_claude/rateLimit'] as Record<string, unknown> | undefined;
  const status = info?.status;
  if (!info || (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected')) return null;
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const resetsAt = number(info.resetsAt);
  return {
    status,
    resetsAt: resetsAt === null ? null : resetsAt * 1000,
    window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
    utilization: number(info.utilization),
  };
}
