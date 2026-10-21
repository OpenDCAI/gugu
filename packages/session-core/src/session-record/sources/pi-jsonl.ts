import { isAbsolute, join } from 'node:path';

import type { ContentBlock, SessionUpdate } from '@agentclientprotocol/sdk';

import type { RecordBoundary, RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { findUnder, isFile } from './find-file';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  parseTimestamp,
  type SessionRecordSourceOptions,
  toolCallStart,
  toolKindTable
} from './shared';
import { createTreeJsonlSource, type TreeNode } from './tree-jsonl';


/** pi 的会话文件(pi `docs/session-format.md`):条目经 `id` / `parentId` 成树，文件头(`type: session`)不在树上。 */
export function createPiJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return createTreeJsonlSource(locator, options, () => resolveSessionFile(locator), {
    name: 'pi',
    toNode: (raw) =>
      raw.type === 'session' || typeof raw.id !== 'string'
        ? null
        : { id: raw.id, parentId: typeof raw.parentId === 'string' ? raw.parentId : null, raw },
    decode
  });
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

/**
 * 终端腿上咕咕记下的是会话文件的绝对路径(pi 扩展报 `ctx.sessionManager.getSessionFile()`);
 * ACP 腿记下的是 pi 自己的会话 id(pi-acp 用 pi 的 `sessionId` 当 ACP 会话 id),
 * 文件名是 `<时间戳>_<会话 id>.jsonl`,在 `sessions/<工作目录改写>/` 下。
 */
async function resolveSessionFile(locator: SessionRecordLocator): Promise<string> {
  const id = locator.providerSessionId;
  if (isAbsolute(id)) {
    if (await isFile(id)) return id;
    throw new SessionRecordNotFoundError(`pi 会话文件不在了：${id}`, [id]);
  }
  const suffix = `_${id}.jsonl`;
  const hit = await findUnder(locator.roots, '', (name) => name.endsWith(suffix));
  if (hit) return hit;
  throw new SessionRecordNotFoundError(
    `找不到 pi 会话记录：sessionId=${id}`,
    locator.roots.map((root) => join(root, '*', `*${suffix}`))
  );
}

// ─── 映射 ────────────────────────────────────────────────────────────────────
// 消息形状见 pi `docs/message-types.md`:user / assistant / toolResult 三种进时间线;
// system、自定义、压缩摘要这些是给模型看的上下文，不是谁说的话。

function decode(entry: TreeNode): RecordEntry[] {
  if (entry.raw.type !== 'message') return [];
  const message = asRecord(entry.raw.message);
  if (!message) return [];
  const at = typeof message.timestamp === 'number' ? message.timestamp : parseTimestamp(entry.raw.timestamp);
  const stamp = at !== undefined ? { at } : {};
  const key = (index: number) => `pi:${entry.id}#${index}`;
  const out: RecordEntry[] = [];

  if (message.role === 'user') {
    blocksOf(message.content).forEach((block, index) => {
      out.push({ key: key(index), ...stamp, update: { sessionUpdate: 'user_message_chunk', content: block, messageId: key(0) } });
    });
    return out;
  }

  if (message.role === 'toolResult') {
    const toolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : entry.id;
    const content = blocksOf(message.content).map((block) => ({ type: 'content' as const, content: block }));
    out.push({
      key: key(0),
      ...stamp,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: message.isError === true ? 'failed' : 'completed',
        ...(content.length > 0 ? { content } : {})
      }
    });
    return out;
  }

  if (message.role !== 'assistant') return [];
  const blocks = Array.isArray(message.content) ? message.content : [];
  blocks.forEach((value, index) => {
    const update = assistantBlock(asRecord(value), key(index));
    if (update) out.push({ key: key(index), ...stamp, update });
  });
  const boundary = boundaryOf(message.stopReason, blocks.some((block) => asRecord(block)?.type === 'toolCall'));
  if (boundary) out.push(boundaryEntry(`pi:${entry.id}`, at, boundary));
  return out;
}

function assistantBlock(block: Record<string, unknown> | null, messageId: string): SessionUpdate | null {
  if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
    return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: block.text }, messageId };
  }
  if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
    return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.thinking }, messageId };
  }
  if (block?.type === 'toolCall' && typeof block.id === 'string') {
    const name = typeof block.name === 'string' ? block.name : 'tool';
    return toolCallStart(block.id, name, piToolKind(name), block.arguments);
  }
  return null;
}

/**
 * pi 的 `stopReason`(pi-ai `StopReason`):`toolUse` 是还要接着干,❌ 不是边界。
 * 带工具调用的 `length` 也不是:pi 的循环(`agent-loop.ts`)把这些被截断的调用全判失败
 * (`failToolCallsFromTruncatedMessage`),再接着跑下一步;只有不带调用的 `length` 才结束这一轮。
 */
function boundaryOf(stopReason: unknown, hasToolCalls: boolean): RecordBoundary | null {
  switch (stopReason) {
    case 'stop':
      return { kind: 'turn_end', stopReason: 'end_turn' };
    case 'error':
      return { kind: 'turn_failed' };
    case 'length':
      return hasToolCalls ? null : { kind: 'turn_end', stopReason: 'max_tokens' };
    case 'aborted':
      return { kind: 'turn_aborted' };
    default:
      return null;
  }
}

/** user / toolResult 的 content:一个字符串，或 text / image 块。 */
function blocksOf(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: ContentBlock[] = [];
  for (const value of content) {
    const block = asRecord(value);
    if (block?.type === 'text' && typeof block.text === 'string') out.push({ type: 'text', text: block.text });
    else if (block?.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      out.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    }
  }
  return out;
}

/** pi 内置工具名 → ACP ToolKind。名单外一律 'other'。 */
const piToolKind = toolKindTable({ read: ['read'], edit: ['edit', 'write'], execute: ['bash'], search: ['grep', 'find', 'ls'] });
