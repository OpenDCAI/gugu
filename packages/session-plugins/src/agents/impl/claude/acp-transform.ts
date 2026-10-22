import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent, SessionUsage } from '@gugu/session-core/acp';
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
  if (update.kind === 'message' && update.role === 'user') {
    const text = update.text.trim();
    if (isLocalCommandChunk(text)) return { kind: 'ignored' };
    // Child completion is owned by v2 subagent state, never reconstructed from prose.
    if (text.startsWith('<task-notification>')) return { kind: 'ignored' };
    // 子智能体给父会话发的话(`Another Claude session sent a message:` + `<agent-message>`)。
    // 供应商 live 时根本不发它(字符串形态的 user 消息在适配器里被跳过),只有 replay 会
    // 把它当 user_message_chunk 吐出来 —— 那它就会开一轮、钉在顶上、还能被「取回指令」
    // 塞进输入框。owner 2026-09-06:「别的 agent 给这个 agent 发的信息其实也是通知,
    // 不应该计入消息」。⇒ 与 live 同一个样子:不进转录。
    if (isPeerAgentMessage(text)) return { kind: 'ignored' };
    return update;
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

  // Standard v2 child sessions own their lifecycle. Agent/Task are ordinary
  // delegation tool calls; interpreting them again would create duplicate agents.
  if (isSubagentBookkeepingToolName(claudeToolName(raw))) return { kind: 'ignored' };

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
  const delegation = toolName === 'Agent' || toolName === 'Task' ? { toolKind: 'subagent' } : {};
  return { ...update, ...parentPatch, ...outputPatch, ...exitPatch, ...namePatch, ...delegation };
}

type ClaudeMeta = {
  claudeCode?: {
    parentToolUseId?: unknown;
    toolName?: unknown;
    toolResponse?: unknown;
  };
};

function claudeMeta(raw: SessionUpdate): ClaudeMeta['claudeCode'] | undefined {
  return (raw._meta as ClaudeMeta | null | undefined)?.claudeCode;
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

function rawOutputText(raw: SessionUpdate): string | undefined {
  const rawOutput = (raw as { rawOutput?: unknown }).rawOutput;
  return typeof rawOutput === 'string' && rawOutput.length > 0 ? rawOutput : undefined;
}

function isLocalCommandChunk(text: string): boolean {
  return text.startsWith('<local-command-') || text.includes('<command-name>');
}

/** 真机 2026-09-06 的会话 JSONL:`Another Claude session sent a message:\n<agent-message from="…">…`。 */
function isPeerAgentMessage(text: string): boolean {
  const head = text.trimStart();
  return head.startsWith('Another Claude session sent a message:') && head.includes('<agent-message');
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
