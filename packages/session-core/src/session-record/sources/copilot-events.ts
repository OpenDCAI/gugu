import { join } from 'node:path';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';

import type { RecordBoundary, RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { isFile } from './find-file';
import { createJsonlTailSource } from './jsonl-tail-source';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  parseTimestamp,
  type SessionRecordSourceOptions,
  toolCallResult,
  toolCallStart,
  toolKindTable
} from './shared';


/**
 * copilot 的 `session-state/<会话 id>/events.jsonl`:一行一个事件，只追加。每个事件自带 uuid `id`,
 * 它就是 key 的来源 —— 不需要按序号编号，重读同一份文件得到同一批 key。
 * 每行也带 `parentId`,但那是事件因果链，不是可回退的分支(mac1 上 300 份记录里没有一次回退),
 * 所以按单线尾读。
 */
export function createCopilotEventsSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return createJsonlTailSource<null>(locator, options, {
    name: 'copilot',
    resumeVersion: 2,
    resolve: () => resolveEventsFile(locator),
    initial: () => null,
    decode: (event) => (typeof event.id === 'string' && typeof event.type === 'string' ? decode(event) : null)
  });
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

async function resolveEventsFile(locator: SessionRecordLocator): Promise<string> {
  const paths = locator.roots.map((root) => join(root, locator.providerSessionId, 'events.jsonl'));
  for (const path of paths) {
    if (await isFile(path)) return path; // 不是就看下一个根
  }
  throw new SessionRecordNotFoundError(`找不到 copilot 会话记录：sessionId=${locator.providerSessionId}`, paths);
}

// ─── 映射 ────────────────────────────────────────────────────────────────────
// 进时间线的只有主 agent 的话与工具:后台 / 同步子代理的消息带 `parentToolCallId`,它的提示词是一条
// `source: agent-<…>` 的 user.message —— 都住在主会话的文件里,但不是这条会话里谁说的话。
// 子代理本身经它的 `task` 工具卡出现在主时间线上。`model.*`、`hook.*`、用量这些是遥测,不是内容。

function decode(event: Record<string, unknown>): RecordEntry[] {
  const id = event.id as string;
  const data = asRecord(event.data) ?? {};
  const at = parseTimestamp(event.timestamp);
  const stamp = at !== undefined ? { at } : {};
  const key = (index: number) => `copilot:${id}#${index}`;
  const boundary = (b: RecordBoundary): RecordEntry => boundaryEntry(`copilot:${id}`, at, b);

  switch (event.type) {
    case 'user.message': {
      if (typeof data.source === 'string' && data.source.startsWith('agent-')) return [];
      const text = typeof data.content === 'string' ? data.content : '';
      if (!text) return [];
      return [{ key: key(0), ...stamp, event: { kind: 'message', role: 'user', messageId: key(0), text } }];
    }
    case 'assistant.message': {
      if (data.parentToolCallId !== undefined) return [];
      const out: RecordEntry[] = [];
      const push = (event: NormalizedEvent) => out.push({ key: key(out.length), ...stamp, event });
      if (typeof data.reasoningText === 'string' && data.reasoningText) {
        push({ kind: 'thinking', messageId: key(0), text: data.reasoningText });
      }
      if (typeof data.content === 'string' && data.content) {
        push({ kind: 'message', role: 'assistant', messageId: key(0), text: data.content });
      }
      const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      for (const value of requests) {
        const request = asRecord(value);
        if (typeof request?.toolCallId !== 'string') continue;
        const name = typeof request.name === 'string' ? request.name : 'tool';
        const title = typeof request.toolTitle === 'string' ? request.toolTitle : name;
        push(toolCallStart(request.toolCallId, name, copilotToolKind(name), request.arguments, title));
      }
      // 不再要工具的那一步就是这一轮的最后一步(同 claude 的 stop_reason ≠ tool_use)。
      if (requests.length === 0) out.push(boundary({ kind: 'turn_end', stopReason: 'end_turn' }));
      return out;
    }
    case 'tool.execution_complete': {
      if (data.parentToolCallId !== undefined || typeof data.toolCallId !== 'string') return [];
      const failed = data.success !== true;
      const text = failed
        ? (asRecord(data.error)?.message ?? asRecord(data.result)?.content)
        : asRecord(data.result)?.content;
      return [
        {
          key: key(0),
          ...stamp,
          event: toolCallResult(data.toolCallId, failed ? 'failed' : 'completed',
            typeof text === 'string' && text ? { text } : {})
        }
      ];
    }
    case 'abort':
      return [boundary({ kind: 'turn_aborted' })];
    case 'session.error':
      // 重试用尽、这一轮停在错误上。
      return [boundary({ kind: 'turn_failed' })];
    default:
      return [];
  }
}

/** copilot 内置工具名 → ACP ToolKind。名单外(MCP 工具等)一律 'other'。 */
const copilotToolKind = toolKindTable({ execute: ['bash', 'read_bash', 'write_bash'], read: ['view'], edit: ['edit', 'create'], search: ['grep', 'glob'], fetch: ['web_fetch'] });
