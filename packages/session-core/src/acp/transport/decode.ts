/**
 * Pure ACP transport decoding into the host's domain vocabulary.
 * Wire versions, negotiated extensions, permission bodies and vendor fields are
 * interpreted here; the parser consumes domain events and never wire notifications.
 * Missing IDs, replacement/null semantics and opaque content remain intact.
 */

import type { SessionUpdate, SessionConfigOption, ToolCallContent, ToolCallLocation, RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { AcpPermissionParams } from '../../agents/plugins/capabilities/acp';
import type { PermissionSubject } from '../models/permissions';
import { normalizeToolContent } from './file-patch';
import { serializePayload, projectToolContent } from '../models/tool-payload';
import { messageContentText, type EntityContent, type EntityMeta } from '../models/entity-content';
import type { ToolImage } from '../models/turns/tool-calls';
import type { SessionTerminalUpdate, SessionTerminalChunk } from '../session-protocol';
import type {
  NormalizedEvent,
  NormalizedToolLocation,
  NormalizedToolStatus,
} from '../reducer/normalized-event';

/** Decode protocol option/group identities into the host's config vocabulary. */
export function decodeConfigOptions(options: readonly unknown[]): SessionConfigOption[] {
  return options.map((value) => {
    const option = value as Record<string, unknown>;
    if (typeof option.configId !== 'string') return option as SessionConfigOption;
    const { configId, ...rest } = option;
    return { ...rest, id: configId,
      ...(Array.isArray(rest.options) ? { options: rest.options.map((entry) => {
        const { groupId, ...group } = entry as Record<string, unknown>;
        return groupId === undefined ? entry : { ...group, group: groupId };
      }) } : {}) } as SessionConfigOption;
  });
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

function extractTextOutput(content: ReadonlyArray<ToolCallContent> | null | undefined): string | undefined {
  return projectToolContent((content ?? []) as readonly EntityContent[]).outputText;
}

function extractImages(content: ReadonlyArray<ToolCallContent> | null | undefined): ToolImage[] | undefined {
  const images = projectToolContent((content ?? []) as readonly EntityContent[]).images;
  return images.length ? images : undefined;
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
function extractTerminalId(update: unknown): string | undefined {
  const content = (update as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const raw = block as { type?: unknown; terminalId?: unknown };
    if (raw.type === 'terminal' && typeof raw.terminalId === 'string') return raw.terminalId;
  }
  return undefined;
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
function extractVendorToolName(update: unknown): string | undefined {
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

/** Legacy negotiated child facts, consumed only by the v1 transport entry. */
function decodeLegacyChildUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = wrapped;
  switch ((update as unknown as { sessionUpdate?: string }).sessionUpdate) {
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
      };
      // 没有会话号这条就没有身份可用 —— ❌ 别编一个,宁可丢弃。
      if (!raw.subagentSessionId) return { kind: 'ignored' };
      return {
        kind: 'subagent',
        // 会话形态下派它出去的那次调用由 reducer 按会话号回填;这里先用会话号占位,
        // ❌ 不编一个假的 toolCallId。
        toolCallId: raw.subagentSessionId,
        subagentSessionId: raw.subagentSessionId,
        ...(raw.name ? { title: raw.name } : {}),
        ...(raw.task ? { inputSummary: raw.task } : {}),
        status: raw.background === true ? 'completed' : 'in_progress',
        parentToolCallId: raw.parentToolCallId ?? null,
        canCancel: raw.capabilities?.cancel === true,
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

    default: return null;
  }
}

/** Standard child association, independent of the child's own event stream. */
function decodeChildUpdate(update: SessionUpdate): NormalizedEvent | null {
  switch ((update as unknown as { sessionUpdate?: string }).sessionUpdate) {
    case 'subagent_update': {
      const raw = update as unknown as {
        sessionId?: string;
        title?: string | null;
        description?: string | null;
        capabilities?: { cancel?: unknown } | null;
        state?: { state?: string; stopReason?: string } | null;
      };
      if (!raw.sessionId) return { kind: 'ignored' };
      const id = raw.sessionId;
      const state = raw.state?.state;
      if (raw.title !== undefined || raw.capabilities !== undefined) {
        return {
          kind: 'subagent',
          toolCallId: id,
          subagentSessionId: id,
          ...(raw.title ? { title: raw.title } : {}),
          ...(raw.description ? { inputSummary: raw.description } : {}),
          status: state === 'idle' ? 'completed' : 'in_progress',
          parentToolCallId: null,
          canCancel: raw.capabilities?.cancel != null,
        };
      }
      if (state === 'running' || state === 'requires_action') {
        return { kind: 'subagent_update', toolCallId: id, agentId: id, subagentSessionId: id, status: 'in_progress' };
      }
      if (state !== 'idle') return { kind: 'ignored' };
      const stopReason = raw.state?.stopReason;
      return {
        kind: 'subagent_done',
        toolCallId: id,
        agentId: id,
        subagentSessionId: id,
        status: stopReason === 'cancelled' ? 'stopped' : stopReason === 'error' ? 'failed' : 'completed',
      };
    }

    default: return null;
  }
}

/** The negotiated transport selects its namespace; both produce one task vocabulary. */
function decodeAsyncTaskUpdate(update: SessionUpdate, prefix: 'async_task_' | '_async_task_'): NormalizedEvent | null {
  const name = (update as unknown as { sessionUpdate?: string }).sessionUpdate;
  if (!name?.startsWith(prefix)) return null;
  switch (name.slice(prefix.length)) {
    case 'spawned': {
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

    case 'progress': {
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

    case 'state_update': {
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
  const update = wrapped;
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
 */
function decodeNoticeSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = wrapped as unknown as {
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
 * agent 自己报的状态(ACP v2 的 `state_update`)。
 */
function decodeStateSessionUpdate(wrapped: SessionUpdate): NormalizedEvent | null {
  const update = wrapped as unknown as { sessionUpdate?: string; state?: unknown; _meta?: { summary?: unknown } };
  if (update.sessionUpdate !== 'state_update') return null;
  const { sessionUpdate: _, ...fields } = update;
  return update.state === 'running' || update.state === 'requires_action' || update.state === 'idle' || update.state === 'unknown'
    ? { ...fields, kind: 'agent_state', source: 'agent',
        ...(typeof update._meta?.summary === 'string' ? { summary: update._meta.summary } : {}) } as NormalizedEvent
    : { kind: 'ignored' };
}

/**
 * Decode a raw ACP SessionUpdate into a NormalizedEvent.
 * Stateless — does not depend on turn or session context.
 */
/** Decode snapshot updates without passing them through append-only chunk shapes. */
function decodeEntityContentUpdate(update: SessionUpdate): NormalizedEvent | null {
  const terminal = update as unknown as { sessionUpdate: string };
  if (terminal.sessionUpdate === 'terminal_update') {
    const { sessionUpdate: _, ...fields } = update as unknown as SessionTerminalUpdate & { sessionUpdate: string };
    return { kind: 'terminal_update', terminal: fields };
  }
  if (terminal.sessionUpdate === 'terminal_output_chunk') {
    const { sessionUpdate: _, ...fields } = update as unknown as SessionTerminalChunk & { sessionUpdate: string };
    return { kind: 'terminal_chunk', terminal: fields };
  }
  const raw = update as unknown as {
    sessionUpdate: string; messageId: string; content?: EntityContent[] | EntityContent | null;
    toolCallId: string; _meta?: EntityMeta | null;
  };
  if (raw.sessionUpdate === 'agent_message' || raw.sessionUpdate === 'user_message' || raw.sessionUpdate === 'agent_thought') {
    const content = raw.content as readonly EntityContent[] | null | undefined;
    return {
      kind: raw.sessionUpdate === 'agent_thought' ? 'thinking' : 'message',
      ...(raw.sessionUpdate === 'agent_thought' ? {} : { role: raw.sessionUpdate === 'user_message' ? 'user' : 'assistant' }),
      messageId: raw.messageId, text: messageContentText(content ?? []), contentMode: 'replace',
      ...(raw.sessionUpdate === 'user_message' && raw._meta?.guguSteering === true ? { steering: true } : {}),
      ...(typeof raw._meta?.guguRevertAnchor === 'string' ? { revertAnchor: raw._meta.guguRevertAnchor } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(raw._meta !== undefined ? { _meta: raw._meta } : {}),
    } as NormalizedEvent;
  }
  if (raw.sessionUpdate === 'plan_removed') return { kind: 'plan_remove', planId: (update as unknown as { planId: string }).planId };
  if (raw.sessionUpdate === 'plan_update') {
    const plan = (update as unknown as { plan: EntityContent & { planId: string; entries?: unknown[] } }).plan;
    return { kind: 'plan', planId: plan.planId, entries: plan.type === 'items' ? plan.entries as Extract<NormalizedEvent, {kind: 'plan'}>['entries'] : [], body: plan, ...(raw._meta !== undefined ? { _meta: raw._meta } : {}) };
  }
  if (raw.sessionUpdate === 'tool_call_content_chunk') {
    return { kind: 'tool_update', toolCallId: raw.toolCallId, contentBlocks: normalizeToolContent([raw.content as EntityContent]) as EntityContent[], contentMode: 'append' };
  }
  return null;
}

/** v1 standard notifications and explicitly negotiated AIR facts enter here. */
export function decodeSessionUpdate(raw: unknown): NormalizedEvent {
  const update = raw as SessionUpdate;
  return decodeLegacyChildUpdate(update) ?? decodeAsyncTaskUpdate(update, 'async_task_') ?? decodeStandardSessionUpdate(update);
}

/** v1's toolCall and v2's subject enter the host as one permission vocabulary. */
export function decodePermissionRequest(value: unknown): AcpPermissionParams {
  const { toolCall, ...request } = value as Omit<RequestPermissionRequest, 'toolCall'> & {
    toolCall?: RequestPermissionRequest['toolCall'];
    title?: string;
    description?: string | null;
    subject?: PermissionSubject | null;
  };
  const subject = request.subject !== undefined ? request.subject
    : toolCall ? { type: 'tool_call', toolCall } : undefined;
  const tool = subject?.type === 'tool_call' ? subject.toolCall : undefined;
  return {
    ...request,
    ...(subject !== undefined ? { subject } : {}),
    ...(tool ? { toolCall: decodeToolUpdate(tool) } : {}),
  };
}

/** v2 notifications are decoded directly, never translated to v1 wire shapes. */
export function decodeV2SessionUpdate(raw: unknown): NormalizedEvent {
  const update = raw as SessionUpdate;
  return decodeAsyncTaskUpdate(update, '_async_task_') ?? decodeStandardSessionUpdate(update);
}

/** Shared tool-body decoding for updates and permission subjects; no synthetic notification. */
function decodeToolUpdate(update: unknown): Extract<NormalizedEvent, { kind: 'tool_update' }> {
  const raw = update as Extract<SessionUpdate, { sessionUpdate: 'tool_call_update' }> & { name?: string | null };
  const payload = (value: unknown) => value === null ? null : typeof value === 'string' ? value : serializePayload(value);
  const content = raw.content;
  const outputText = extractTextOutput(content ?? undefined);
  const images = extractImages(content);
  const terminalId = extractTerminalId(update);
  const locations = normalizeLocations(raw.locations);
  const name = raw.name !== undefined ? raw.name : extractVendorToolName(update);
  return {
    kind: 'tool_update', toolCallId: raw.toolCallId,
    ...(raw.title !== undefined ? { title: raw.title } : {}),
    ...(name !== undefined ? { toolName: name } : {}),
    ...(raw.kind !== undefined ? { toolKind: raw.kind } : {}),
    ...(raw.status !== undefined ? { status: raw.status as NormalizedToolStatus | null } : {}),
    ...(content !== undefined ? { contentBlocks: normalizeToolContent(content as EntityContent[] | null, raw.kind), contentMode: 'replace' } : {}),
    ...(locations !== undefined ? { locations } : {}),
    ...(outputText !== undefined ? { outputText } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(raw.rawInput !== undefined ? { rawInput: payload(raw.rawInput) } : {}),
    ...(raw.rawOutput !== undefined ? { rawOutput: payload(raw.rawOutput) } : {}),
    ...(terminalId !== undefined ? { terminalId } : {}),
    ...(raw._meta !== undefined ? { _meta: raw._meta } : {}),
  };
}

function decodeStandardSessionUpdate(raw: unknown): NormalizedEvent {
  const update = raw as SessionUpdate;
  const contentUpdate = decodeEntityContentUpdate(update);
  if (contentUpdate) return contentUpdate;
  // 先问会话形态那五种(#5117);不归它管才走下面的老分支。
  const subagentSession = decodeChildUpdate(update);
  if (subagentSession) return subagentSession;

  const compaction = decodeCompactionSessionUpdate(update);
  if (compaction) return compaction;

  const notice = decodeNoticeSessionUpdate(update);
  if (notice) return notice;

  const state = decodeStateSessionUpdate(update);
  if (state) return state;

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      return {
        kind: 'message',
        role: 'user',
        messageId: update.messageId ?? null,
        text: update.content.type === 'text' ? update.content.text : '',
        content: [update.content as EntityContent],
        contentMode: 'append',
        ...(typeof update._meta?.guguRevertAnchor === 'string' ? { revertAnchor: update._meta.guguRevertAnchor } : {}),
        ...(update._meta?.guguSteering === true ? { steering: true } : {}),
      };
    }

    case 'agent_message_chunk': {
      return {
        kind: 'message',
        role: 'assistant',
        messageId: update.messageId ?? null,
        text: update.content.type === 'text' ? update.content.text : '',
        content: [update.content as EntityContent],
        contentMode: 'append',
      };
    }

    case 'agent_thought_chunk': {
      return {
        kind: 'thinking',
        messageId: update.messageId ?? null,
        text: update.content.type === 'text' ? update.content.text : '',
        content: [update.content as EntityContent],
        contentMode: 'append',
      };
    }

    case 'tool_call': {
      const terminalId = extractTerminalId(update);
      const inputSummary = extractInputSummary(update);
      const rawInput = extractRawInput(update);
      const rawOutput = extractRawOutput(update);
      const outputText = extractTextOutput(update.content);
      const toolName = (update as unknown as { name?: string | null }).name ?? extractVendorToolName(update);
      const images = extractImages(update.content);
      return {
        kind: 'tool_call',
        ...(update.content !== undefined ? { contentBlocks: normalizeToolContent(update.content as EntityContent[], update.kind) as EntityContent[] } : {}),
        ...(update._meta !== undefined ? { _meta: update._meta } : {}),
        toolCallId: update.toolCallId,
        title: update.title,
        ...(toolName !== undefined ? { toolName } : {}),
        toolKind: update.kind ?? null,
        status: (update.status as NormalizedToolStatus | undefined) ?? null,
        parentToolCallId: null,
        locations: normalizeLocations(update.locations) ?? [],
        ...(inputSummary !== undefined ? { inputSummary } : {}),
        ...(rawInput !== undefined ? { rawInput } : {}),
        ...(rawOutput !== undefined ? { rawOutput } : {}),
        ...(outputText !== undefined ? { outputText } : {}),
        ...(images !== undefined ? { images } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
      };
    }

    case 'tool_call_update':
      return decodeToolUpdate(update);

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
      const options = decodeConfigOptions(Array.isArray(raw.configOptions) ? raw.configOptions : []);
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
