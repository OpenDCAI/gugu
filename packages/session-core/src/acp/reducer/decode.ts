/**
 * Baseline ACP SessionUpdate decoder.
 *
 * Converts raw ACP SDK SessionUpdate notifications into the parser's internal
 * NormalizedEvent vocabulary. This is the parser-owned equivalent of the
 * legacy toAgentUpdate in agent-update.ts — it is stateless, pure, and
 * handles all ACP-specific decoding:
 *
 *   - Extracts text from content blocks for message and thinking variants.
 *   - Extracts diff blocks from ToolCallContent arrays.
 *   - Passes status and kind through unchanged (no UI-level remapping here).
 *   - Preserves missing message ids for the stateful reducer to segment.
 *   - Sets parentToolCallId to null (providers enrich via EnrichHook).
 *   - Returns { kind: 'ignored' } for variants not yet rendered.
 */

import type { SessionUpdate, ToolCallContent, ToolCallLocation } from '@agentclientprotocol/sdk';
import { DRAFT_UPDATE_META_KEY } from '@gugu/core/shared/subagentUpdates.mjs';
import type { ToolImage } from '../models/turns/tool-calls';
import type {
  NormalizedDiff,
  NormalizedEvent,
  NormalizedToolLocation,
  NormalizedToolStatus,
} from './normalized-event';

function extractDiffs(
  content: ReadonlyArray<ToolCallContent> | null | undefined
): NormalizedDiff[] {
  if (!content) return [];
  const diffs: NormalizedDiff[] = [];
  for (const block of content) {
    if (block.type === 'diff') {
      diffs.push({ path: block.path, oldText: block.oldText ?? null, newText: block.newText });
    }
  }
  return diffs;
}

function normalizeLocations(
  locations: ReadonlyArray<ToolCallLocation> | null | undefined
): NormalizedToolLocation[] | null | undefined {
  if (locations === undefined || locations === null) return locations;
  return locations.map((location) => {
    if (location.path.length === 0) throw new Error('ACP tool location path must not be empty');
    return {
      path: location.path,
      ...(location.line !== undefined ? { line: location.line } : {}),
    };
  });
}

function collectTextPayload(value: unknown, parts: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectTextPayload(item, parts);
    return;
  }

  const raw = value as { type?: unknown; text?: unknown; content?: unknown };
  if (raw.type === 'text' && typeof raw.text === 'string') {
    parts.push(raw.text);
    return;
  }
  collectTextPayload(raw.content, parts);
}

function stripSingleCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return match ? match[1] : text;
}

function extractTextOutput(
  content: ReadonlyArray<ToolCallContent> | null | undefined
): string | undefined {
  if (!content) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const raw = block as { type?: unknown; content?: unknown; text?: unknown };
    if (raw.type === 'content') {
      collectTextPayload(raw.content, parts);
    } else if (raw.type === 'text' && typeof raw.text === 'string') {
      parts.push(raw.text);
    }
  }
  const text = parts.join('\n');
  return text ? stripSingleCodeFence(text) : undefined;
}

/**
 * The pictures a tool handed back: the image blocks of its `content` (`{ type: 'content', content: { type: 'image',
 * data, mimeType } }`), as they came. MCP's result blocks are ACP's, so every tool that returns pictures has them here —
 * an App's app_check, a browser screenshot. Its text blocks stay `outputText`; until 10-14 the pictures were dropped.
 */
function extractImages(content: ReadonlyArray<ToolCallContent> | null | undefined): ToolImage[] | undefined {
  if (!content) return undefined;
  const images: ToolImage[] = [];
  for (const block of content) {
    if (block.type !== 'content') continue;
    const inner = block.content as { type?: unknown; data?: unknown; mimeType?: unknown } | null | undefined;
    if (inner?.type !== 'image' || typeof inner.data !== 'string' || !inner.data) continue;
    if (typeof inner.mimeType !== 'string' || !inner.mimeType.startsWith('image/')) continue;
    images.push({ mimeType: inner.mimeType, data: inner.data });
  }
  return images.length > 0 ? images : undefined;
}

/**
 * @@@the terminal reference is a content block, not a field on the tool call.
 *
 * ACP embeds a terminal in a tool call the same way it embeds a diff: as an entry
 * in `content[]`, `{ type: 'terminal', terminalId }`. `ToolCall` and
 * `ToolCallUpdate` carry no `terminalId` of their own — schema 1.1.0 lists their
 * properties as toolCallId / title / kind / status / content / locations /
 * rawInput / rawOutput / _meta, and that is the whole set.
 *
 * This used to read a top-level `terminalId` / `terminal_id` instead. Nothing
 * emits those: across the two recorded transcripts in session-plugins the id occurs
 * only inside `content[]` (Codex) or not at all (Claude Code runs its own shell
 * and never asks the client for a terminal). So the id was never extracted, which
 * left `ChatExecute.terminalId` permanently undefined and the whole live-terminal
 * channel behind it — output while the command runs, and the exit status it
 * finishes with — unreachable in the product. Reading the protocol's own location
 * is what connects that channel; there is no second location to fall back to.
 */
function extractTerminalId(update: SessionUpdate): string | undefined {
  const content = (update as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const raw = block as { type?: unknown; terminalId?: unknown };
    if (raw.type === 'terminal' && typeof raw.terminalId === 'string') return raw.terminalId;
  }
  return undefined;
}

/**
 * Serialize an ACP `rawInput` / `rawOutput` payload for display.
 *
 * ACP types both as free-form JSON, so a string arrives already readable and
 * anything else is pretty-printed once here rather than at each render — the
 * canonical form is a decode concern, how much of it is shown is not.
 * Non-serializable values (cycles) are dropped rather than thrown on: a payload
 * we cannot print must not take the whole tool call's decode down with it.
 */
export function serializePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function extractRawInput(update: SessionUpdate): string | undefined {
  return serializePayload((update as unknown as { rawInput?: unknown }).rawInput);
}

/**
 * 供应商自己的工具名（#7139）：标题常是给人看的显示名（qwen 的计划审批标题「Plan:」、qoder 的「Ready to start
 * implementation?」），认工具得靠它。各家放在 `_meta` 里：`_meta.toolName`（qwen），或 `_meta.<自家键>.toolName`
 * （Claude `claudeCode`、qoder `qoder`）—— 两种都读，❌ 按家写键。几个嵌套键报的名字不一样，就不知道哪个是这次调用的，
 * 不取（❌ 按键的先后挑一个）。
 */
function extractVendorToolName(update: SessionUpdate): string | undefined {
  const meta = (update as unknown as { _meta?: unknown })._meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const direct = (meta as { toolName?: unknown }).toolName;
  if (typeof direct === 'string' && direct) return direct;
  const nested = new Set<string>();
  for (const value of Object.values(meta)) {
    const name = value && typeof value === 'object' ? (value as { toolName?: unknown }).toolName : undefined;
    if (typeof name === 'string' && name) nested.add(name);
  }
  return nested.size === 1 ? [...nested][0] : undefined;
}

function extractRawOutput(update: SessionUpdate): string | undefined {
  return serializePayload((update as unknown as { rawOutput?: unknown }).rawOutput);
}

function extractInputSummary(update: SessionUpdate): string | undefined {
  const raw = update as unknown as {
    inputSummary?: unknown;
    input_summary?: unknown;
    description?: unknown;
  };
  if (typeof raw.inputSummary === 'string') return raw.inputSummary;
  if (typeof raw.input_summary === 'string') return raw.input_summary;
  if (typeof raw.description === 'string') return raw.description;
  return undefined;
}

/**
 * 子智能体与后台任务的会话形态(#5117),独立于主 switch。
 *
 * ⚠️ 为什么不直接写进 `decodeSessionUpdate` 的 switch:那里的判别式是 SDK 的
 * `SessionUpdate` 联合,而这五种是草案字段(agent-client-protocol#1992)还没进已发布的
 * SDK 类型 ⇒ 写成 `case` 会被 TS2678 顶掉("not comparable to type")。把判别式在这里
 * 加宽成 string,主 switch 对其余分支的窄化就不受影响 —— ❌ 别为了少一个函数去把主
 * switch 的判别式整个 `as string`,那会让上面每一条都失去窄化。
 *
 * 返回 `null` = 「这条不归我管」,交回主 switch;❌ 别在这里返回 `{kind:'ignored'}`,
 * 那会把所有普通事件当场吞掉。
 */
/**
 * 草案 update 的信封键。写者是 `acp-stdio.ts` 的 `rewriteDraftSessionUpdates` —— 那里必须在
 * 进 SDK 之前改写,否则 `ClientSideConnection` 的运行时校验会以 `-32602 Invalid params` 把
 * 它们整条扔掉(SDK 1.3.0 的联合里没有草案变体)。
 *
 * ⚠️ 常量定在这里而不是写者那边:依赖方向是 session-plugins → session-core,两处各写一份必然漂移,
 * 而漂移的症状是「事件静默消失」——最难查的那一种。
 */
export { DRAFT_UPDATE_META_KEY };

/** 从信封里取回原始的草案 update;不是信封就返回它自己。 */
function unwrapDraftUpdate(update: SessionUpdate): SessionUpdate {
  const meta = (update as unknown as { _meta?: Record<string, unknown> })._meta;
  const inner = meta?.[DRAFT_UPDATE_META_KEY];
  return inner && typeof inner === 'object' ? (inner as SessionUpdate) : update;
}

function decodeSubagentSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = unwrapDraftUpdate(wrapped);
  switch ((update as unknown as { sessionUpdate?: string }).sessionUpdate) {
    /**
     * 子智能体与后台任务的会话形态(#5117)。这五种只在 `initialize` 谈成
     * `clientCapabilities.subagents` + AIR `asyncTasks` 之后才会来 —— 没谈成时协议按老形态
     * 走,子智能体的一切留在根会话上当普通 tool call,这里一条都收不到。
     *
     * ⚠️ 都走 `as unknown as`:草案字段(agent-client-protocol#1992)还没进已发布的 SDK
     * 类型,`SessionUpdate` 的联合里没有它们。SDK 发布后这些 cast 可以撤掉。
     */
    case 'subagent_spawned': {
      const raw = update as unknown as {
        subagentSessionId?: string;
        name?: string;
        task?: string;
        capabilities?: { cancel?: boolean; close?: boolean } | null;
        background?: boolean;
        model?: string;
        launchToolCallId?: string;
        parentToolCallId?: string;
        request?: string;
        associationOnly?: boolean;
      };
      // 没有会话号这条就没有身份可用 —— ❌ 别编一个,宁可丢弃。
      if (!raw.subagentSessionId) return { kind: 'ignored' };
      return {
        kind: 'subagent',
        ...(raw.launchToolCallId ? { agentId: raw.subagentSessionId } : {}),
        // 会话形态下派它出去的那次调用由 reducer 按会话号回填;这里先用会话号占位,
        // ❌ 不编一个假的 toolCallId。
        toolCallId: raw.launchToolCallId ?? raw.subagentSessionId,
        subagentSessionId: raw.subagentSessionId,
        ...(raw.name ? { title: raw.name } : {}),
        ...(raw.task ? { inputSummary: raw.task } : {}),
        status: raw.background === true ? 'completed' : 'in_progress',
        parentToolCallId: raw.parentToolCallId ?? null,
        canCancel: raw.capabilities?.cancel === true,
        ...(raw.associationOnly ? { associationOnly: true } : {}),
        ...(raw.background === true ? { background: true } : {}),
        ...(raw.model ? { model: raw.model } : {}),
        ...(raw.launchToolCallId ? { agentToolUseId: raw.launchToolCallId } : {}),
        ...(raw.request ? { rawInput: raw.request } : {}),
      };
    }

    case 'subagent_stream': {
      const raw = update as unknown as { subagentSessionId?: string; update?: SessionUpdate };
      if (!raw.subagentSessionId || !raw.update) return { kind: 'ignored' };
      return { kind: 'subagent_stream', subagentSessionId: raw.subagentSessionId, event: decodeSessionUpdate(raw.update) };
    }

    case 'subagent_state_update': {
      const raw = update as unknown as {
        subagentSessionId?: string;
        state?: 'running' | 'completed' | 'failed' | 'cancelled' | 'disconnected';
        canCancel?: boolean;
        summary?: string;
      };
      if (!raw.subagentSessionId || !raw.state) return { kind: 'ignored' };
      if (raw.state === 'running') return {
        kind: 'subagent_update', toolCallId: raw.subagentSessionId, agentId: raw.subagentSessionId,
        subagentSessionId: raw.subagentSessionId, status: 'in_progress', canCancel: raw.canCancel === true,
      };
      return {
        kind: 'subagent_done',
        toolCallId: raw.subagentSessionId,
        agentId: raw.subagentSessionId,
        subagentSessionId: raw.subagentSessionId,
        ...(raw.summary ? { summary: raw.summary } : {}),
        // `cancelled` 在我们的词汇里叫 `stopped`(被叫停);`disconnected` 是失联,
        // ❌ 不折进 failed —— 见 normalized-event.ts 上那条。
        status:
          raw.state === 'cancelled'
            ? 'stopped'
            : raw.state === 'disconnected'
              ? 'disconnected'
              : raw.state,
      };
    }

    case 'async_task_spawned': {
      const raw = update as unknown as {
        asyncTaskId?: string;
        name?: string;
        taskType?: string;
        description?: string;
        showInTranscript?: boolean;
        canStop?: boolean;
        outputFilePath?: string;
        toolCallId?: string;
      };
      if (!raw.asyncTaskId) return { kind: 'ignored' };
      return {
        kind: 'async_task',
        asyncTaskId: raw.asyncTaskId,
        name: raw.name ?? '',
        taskType: raw.taskType ?? '',
        description: raw.description ?? '',
        // 缺席按**不显示 / 不能停**处理:两个都是「没被授权」那一侧,
        // ❌ 别默认成 true —— 那会画出按了没反应的停止按钮。
        showInTranscript: raw.showInTranscript === true,
        canStop: raw.canStop === true,
        ...(raw.outputFilePath ? { outputFilePath: raw.outputFilePath } : {}),
        ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
      };
    }

    case 'async_task_progress': {
      const raw = update as unknown as {
        asyncTaskId?: string;
        description?: string;
        summary?: string;
        lastToolName?: string;
        usage?: { totalTokens?: number; toolUses?: number; durationMs?: number } | null;
        outputFilePath?: string;
        toolCallId?: string;
      };
      if (!raw.asyncTaskId) return { kind: 'ignored' };
      const u = raw.usage;
      return {
        kind: 'async_task_progress',
        asyncTaskId: raw.asyncTaskId,
        ...(raw.description ? { description: raw.description } : {}),
        ...(raw.summary ? { summary: raw.summary } : {}),
        ...(raw.lastToolName ? { lastToolName: raw.lastToolName } : {}),
        ...(u && typeof u.totalTokens === 'number'
          ? {
              usage: {
                totalTokens: u.totalTokens,
                toolUses: u.toolUses ?? 0,
                durationMs: u.durationMs ?? 0,
              },
            }
          : {}),
        ...(raw.outputFilePath ? { outputFilePath: raw.outputFilePath } : {}),
        ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
      };
    }

    case 'async_task_state_update': {
      const raw = update as unknown as {
        asyncTaskId?: string;
        state?: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
        summary?: string;
        outputFilePath?: string;
        toolCallId?: string;
      };
      if (!raw.asyncTaskId || !raw.state) return { kind: 'ignored' };
      return {
        kind: 'async_task_state',
        asyncTaskId: raw.asyncTaskId,
        state: raw.state,
        ...(raw.summary ? { summary: raw.summary } : {}),
        ...(raw.outputFilePath ? { outputFilePath: raw.outputFilePath } : {}),
        ...(raw.toolCallId ? { toolCallId: raw.toolCallId } : {}),
      };
    }
    default:
      return null;
  }
}

/** RFD 的摘要块是 ContentBlock;只有 text 这一种画得出来,其余（图片等）当没有摘要。 */
function compactionSummaryText(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null
      && (b as { type?: unknown }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('');
  return text || undefined;
}

/**
 * 适配器给压缩打的那个 `_meta` 键（`@agentclientprotocol/claude-agent-acp`
 * dist/context-compaction-meta.d.ts 实查）。它自己的注释写明是
 * 「provider-neutral metadata for a synthetic ACP context-compaction tool call」——
 * 所以认这个键**不是**认某一家的文案,换一家适配器只要打同一个键就同样认得出。
 */
const CONTEXT_COMPACTION_META_KEY = 'contextCompaction';

interface ContextCompactionMeta {
  trigger?: 'manual' | 'automatic';
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string;
}

/** 从一条 tool_call / tool_call_update 上取压缩元数据;不是压缩就返回 null。 */
function contextCompactionMeta(update: SessionUpdate): ContextCompactionMeta | null {
  const meta = (update as unknown as { _meta?: Record<string, unknown> })._meta;
  const raw = meta?.[CONTEXT_COMPACTION_META_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  return raw as ContextCompactionMeta;
}

/**
 * ACP 的 tool status → 压缩行的三态。`pending` 也算「在压」,用户看到的是同一件事。
 *
 * ⚠️ **没带 status 就返回 undefined,❌ 不许兜底成 in_progress。** 适配器收尾时会发两条:
 * 先 `finish("completed")`(带 status),收到 `compact_boundary` 后再发一条只补 token 数的
 * `tool_call_update` —— 它**只在第一次终报时**带 status(claude-agent-acp 0.75.1
 * context-compaction.js 的 `firstTerminal`)。把缺席解成 in_progress,那条补数就会把
 * 已完成的压缩改回「正在压缩」,界面上永远停在那里。
 */
function compactionStatusFromTool(status: unknown): 'in_progress' | 'completed' | 'failed' | undefined {
  if (status === undefined || status === null) return undefined;
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'in_progress';
}

/**
 * 上下文压缩的边界。**两条来源**,认哪条取决于对面适配器:
 *
 * ① `tool_call` / `tool_call_update` 上挂 `_meta.contextCompaction` —— 今天实际在用的那条。
 *    `claude-agent-acp` 0.75.1 把一次压缩发成一个合成 tool call
 *    （title `Compact conversation`、kind `think`、`in_progress` → `completed`/`failed`）,
 *    元数据全在那个 `_meta` 里。❌ 不认这个键的话它会掉进「不认识的工具调用」,
 *    压缩在界面上就长成了一个工具节点 —— 那正是 2026-09-10 实测到的样子。
 * ② `compaction_update` / `compaction_summary_chunk`（ACP `session-compaction` RFD 的草案字段）
 *    —— 至今没有一家发,接着等。草案字段不在已发布的 `@agentclientprotocol/sdk`（0.22.1 实查）
 *    联合里 ⇒ 要 `as unknown as`,也要靠 `acp-stdio.ts` 的信封才进得了 SDK 的门。
 *
 * ⚠️ 返回 `null` = 「这条不归我管」,交回主 switch（普通工具调用就是走这条路出去的）。
 */
function decodeCompactionSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = unwrapDraftUpdate(wrapped);
  switch ((update as unknown as { sessionUpdate?: string }).sessionUpdate) {
    case 'tool_call':
    case 'tool_call_update': {
      const meta = contextCompactionMeta(update);
      if (!meta) return null; // 普通工具调用,交回主 switch
      const raw = update as unknown as { toolCallId?: string; status?: unknown };
      if (!raw.toolCallId) return { kind: 'ignored' };
      const status = compactionStatusFromTool(raw.status);
      return {
        kind: 'compaction',
        compactionId: raw.toolCallId,
        ...(status ? { status } : {}),
        ...(meta.trigger ? { trigger: meta.trigger } : {}),
        ...(typeof meta.preTokens === 'number' ? { preTokens: meta.preTokens } : {}),
        ...(typeof meta.postTokens === 'number' ? { postTokens: meta.postTokens } : {}),
        ...(typeof meta.durationMs === 'number' ? { durationMs: meta.durationMs } : {}),
        ...(meta.error ? { error: meta.error } : {}),
      };
    }

    case 'compaction_update': {
      const raw = update as unknown as {
        compactionId?: string;
        status?: 'in_progress' | 'completed' | 'failed';
        summary?: unknown;
      };
      // 没有 id 就对不上号,续报会各自长一行。❌ 别编一个。
      if (!raw.compactionId || !raw.status) return { kind: 'ignored' };
      const summary = compactionSummaryText(raw.summary);
      return {
        kind: 'compaction',
        compactionId: raw.compactionId,
        status: raw.status,
        ...(summary ? { summary } : {}),
      };
    }

    case 'compaction_summary_chunk': {
      const raw = update as unknown as {
        compactionId?: string;
        content?: { type?: string; text?: string };
      };
      if (!raw.compactionId) return { kind: 'ignored' };
      if (raw.content?.type !== 'text' || !raw.content.text) return { kind: 'ignored' };
      return {
        kind: 'compaction_summary_chunk',
        compactionId: raw.compactionId,
        text: raw.content.text,
      };
    }

    default:
      return null;
  }
}

/**
 * 供应商提示(ACP `notice`)是会话里发生的一件事,❌ 不是 agent 说的话 ⇒ `session_notice`。
 * ⚠️ 是 notice 就**绝不**返回 null:信封的 toolCallId 只是填位,交回主 switch 会长出一条工具行。
 */
function decodeNoticeSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = unwrapDraftUpdate(wrapped) as unknown as {
    sessionUpdate?: string;
    title?: unknown;
    description?: unknown;
  };
  if (update.sessionUpdate !== 'notice') return null;
  if (typeof update.title !== 'string' || !update.title) return { kind: 'ignored' };
  const description = typeof update.description === 'string' && update.description ? update.description : null;
  return { kind: 'session_notice', code: 'provider-notice', title: update.title, detail: description ?? update.title };
}

/**
 * agent 自己报的状态(ACP v2 草案 `state_update`,v1 上由客户端声明 `session-state` 才发)。
 * ⚠️ 是 state_update 就**绝不**返回 null:信封的 toolCallId 只是填位,交回主 switch 会长出一条工具行。
 */
function decodeStateSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = unwrapDraftUpdate(wrapped) as unknown as Extract<NormalizedEvent, { kind: 'agent_state' }> & { sessionUpdate?: string };
  if (update.sessionUpdate !== 'state_update') return null;
  return update.state === 'running' || update.state === 'requires_action' || update.state === 'idle'
    ? {
        kind: 'agent_state', state: update.state,
        ...(update.stopReason ? { stopReason: update.stopReason } : {}),
        ...(update.error ? { error: update.error } : {}),
        ...(update.usage ? { usage: update.usage } : {}),
        ...(update._meta ? { _meta: update._meta } : {}),
      }
    : { kind: 'ignored' };
}

/**
 * Decode a raw ACP SessionUpdate into a NormalizedEvent.
 * Stateless — does not depend on turn or session context.
 */
export function decodeSessionUpdate(update: SessionUpdate): NormalizedEvent {
  // 先问会话形态那五种(#5117);不归它管才走下面的老分支。
  const subagentSession = decodeSubagentSessionUpdate(update);
  if (subagentSession) return subagentSession;

  const compaction = decodeCompactionSessionUpdate(update);
  if (compaction) return compaction;

  const notice = decodeNoticeSessionUpdate(update);
  if (notice) return notice;

  const state = decodeStateSessionUpdate(update);
  if (state) return state;

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      if (update.content.type !== 'text') return { kind: 'ignored' };
      return {
        kind: 'message',
        role: 'user',
        messageId: update.messageId ?? null,
        text: update.content.text,
        ...(update._meta?.messageSnapshot === true ? { replace: true } : {}),
        ...(typeof update._meta?.guguRevertAnchor === 'string' ? { revertAnchor: update._meta.guguRevertAnchor } : {}),
      };
    }

    case 'agent_message_chunk': {
      if (update.content.type !== 'text') return { kind: 'ignored' };
      return {
        kind: 'message',
        role: 'assistant',
        messageId: update.messageId ?? null,
        text: update.content.text,
        ...(update._meta?.messageSnapshot === true ? { replace: true } : {}),
      };
    }

    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return { kind: 'ignored' };
      return {
        kind: 'thinking',
        messageId: update.messageId ?? null,
        text: update.content.text,
        ...(update._meta?.messageSnapshot === true ? { replace: true } : {}),
      };
    }

    case 'tool_call': {
      const terminalId = extractTerminalId(update);
      const inputSummary = extractInputSummary(update);
      const rawInput = extractRawInput(update);
      const rawOutput = extractRawOutput(update);
      const outputText = extractTextOutput(update.content);
      const toolName = extractVendorToolName(update);
      const images = extractImages(update.content);
      return {
        kind: 'tool_call',
        toolCallId: update.toolCallId,
        ...(update._meta?.entitySnapshot === true ? { replace: true } : {}),
        title: update.title,
        ...(toolName !== undefined ? { toolName } : {}),
        toolKind: update.kind ?? null,
        status: (update.status as NormalizedToolStatus | undefined) ?? null,
        parentToolCallId: null,
        diffs: extractDiffs(update.content),
        locations: normalizeLocations(update.locations) ?? [],
        ...(inputSummary !== undefined ? { inputSummary } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(outputText !== undefined ? { outputText } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
      };
    }

    case 'tool_call_update': {
      const outputText = extractTextOutput(update.content ?? undefined);
      const images = extractImages(update.content);
      const terminalId = extractTerminalId(update);
      const rawInput = extractRawInput(update);
      const rawOutput = extractRawOutput(update);
      const locations = normalizeLocations(update.locations);
      const toolName = extractVendorToolName(update);
      return {
        kind: 'tool_update',
        toolCallId: update.toolCallId,
        title: update.title ?? null,
        ...(toolName !== undefined ? { toolName } : {}),
        toolKind: update.kind ?? null,
        status: (update.status as NormalizedToolStatus | undefined | null) ?? null,
        parentToolCallId: null,
        diffs: extractDiffs(update.content ?? undefined),
        ...(locations !== undefined ? { locations } : {}),
        ...(outputText !== undefined ? { outputText } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
      };
    }

    case 'plan': {
      return {
        kind: 'plan',
        entries: update.entries.map((e) => ({
          content: e.content,
          status: e.status,
          priority: e.priority,
        })),
      };
    }

    case 'config_option_update': {
      const raw = update as unknown as { configOptions?: unknown };
      const options = Array.isArray(raw.configOptions) ? raw.configOptions : [];
      return { kind: 'config', options };
    }

    case 'current_mode_update': {
      const raw = update as unknown as { currentModeId?: string };
      if (!raw.currentModeId) return { kind: 'ignored' };
      return { kind: 'mode_selected', modeId: raw.currentModeId };
    }

    case 'available_commands_update': {
      const raw = update as unknown as { availableCommands?: unknown };
      const commands = Array.isArray(raw.availableCommands) ? raw.availableCommands : [];
      return { kind: 'commands', commands };
    }

    case 'usage_update': {
      const raw = update as unknown as {
        used?: number;
        size?: number;
        cost?: { amount?: number; currency?: string } | null;
      };
      const contextUsed = raw.used ?? 0;
      const contextSize = raw.size ?? 0;
      const cost =
        raw.cost && typeof raw.cost.amount === 'number' && raw.cost.currency
          ? { amount: raw.cost.amount, currency: raw.cost.currency }
          : null;
      return { kind: 'usage', usage: { contextUsed, contextSize, cost } };
    }

    case 'session_info_update': {
      const raw = update as unknown as { title?: string };
      if (!raw.title) return { kind: 'ignored' };
      return { kind: 'title', title: raw.title };
    }

    // plan_update and plan_removed are UNSTABLE/ID-based ACP variants gated
    // behind PlanCapabilities — not emitted by Claude. Ignored for now.
    default:
      return { kind: 'ignored' };
  }
}
