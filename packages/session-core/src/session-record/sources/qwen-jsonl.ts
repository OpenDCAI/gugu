import { join } from 'node:path';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordContentBlock as ContentBlock } from './shared';

import type { RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { findUnder } from './find-file';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  messageEvent,
  parseTimestamp,
  type SessionRecordSourceOptions,
  toolCallResult,
  toolCallStart,
  toolKindTable
} from './shared';
import { createTreeJsonlSource, type TreeNode } from './tree-jsonl';


/**
 * qwen-code 的会话记录(`core/src/services/chatRecordingService.ts` 的 `ChatRecord`):每行一条，经 `uuid` /
 * `parentUuid` 成树(`/rewind` 回退会另起一支),`type` 是 user / assistant / tool_result / system。
 */
export function createQwenJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return createTreeJsonlSource(locator, options, () => resolveChatFile(locator), {
    name: 'qwen',
    toNode: (raw) =>
      typeof raw.uuid === 'string'
        ? { id: raw.uuid, parentId: typeof raw.parentUuid === 'string' ? raw.parentUuid : null, raw }
        : null,
    decode
  });
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

/**
 * `<根>/projects/<工作目录改写>/chats/<会话 id>.jsonl`。改写规则是 qwen 的 `sanitizeCwd`(非字母数字一律换成 `-`),
 * 宿主不必重算：按会话 id 在每个项目目录里找就是唯一的。
 */
async function resolveChatFile(locator: SessionRecordLocator): Promise<string> {
  const name = `${locator.providerSessionId}.jsonl`;
  const hit = await findUnder(locator.roots, 'chats', name);
  if (hit) return hit;
  throw new SessionRecordNotFoundError(
    `找不到 qwen 会话记录：sessionId=${locator.providerSessionId}`,
    locator.roots.map((root) => join(root, '*', 'chats', name))
  );
}

// ─── 映射 ────────────────────────────────────────────────────────────────────

function decode(node: TreeNode): RecordEntry[] {
  const record = node.raw;
  const at = parseTimestamp(record.timestamp);
  const stamp = at !== undefined ? { at } : {};
  const key = (index: number) => `qwen:${node.id}#${index}`;

  // 一轮正常收尾的记号:ACP 腿上 qwen 在 prompt 以 `end_turn` 结束时写一条 branch_checkpoint
  // (`chatRecordingService.ts` 的 `recordBranchCheckpointTransaction`,别的 stopReason 不写)。
  // 终端腿不写这一条，也没有别的结束记号 —— 那条腿上的回合由下一句话关上。
  if (record.type === 'system') {
    return record.subtype === 'branch_checkpoint'
      ? [boundaryEntry(`qwen:${node.id}`, at, { kind: 'turn_end', stopReason: 'end_turn' })]
      : [];
  }

  const parts = Array.isArray(asRecord(record.message)?.parts) ? (asRecord(record.message)!.parts as unknown[]) : [];

  if (record.type === 'user') {
    // 人说的话才进时间线;通知、定时任务这些是 qwen 替人塞的(`provenance: system`)。
    if (record.provenance !== 'real_user') return [];
    const blocks = parts.flatMap((part) => userBlock(asRecord(part)));
    return blocks.map((block, index) => ({
      key: key(index),
      ...stamp,
      event: messageEvent('user', block, key(0))
    }));
  }

  if (record.type === 'assistant') {
    const out: RecordEntry[] = [];
    parts.forEach((value, index) => {
      const event = assistantPart(asRecord(value), key(index));
      if (event) out.push({ key: key(index), ...stamp, event });
    });
    return out;
  }

  if (record.type === 'tool_result') {
    const result = asRecord(record.toolCallResult);
    const response = asRecord(asRecord(asRecord(parts[0])?.functionResponse));
    const toolCallId = typeof result?.callId === 'string' ? result.callId : typeof response?.id === 'string' ? response.id : node.id;
    const display = result?.resultDisplay;
    return [
      {
        key: key(0),
        ...stamp,
        event: toolCallResult(toolCallId, result?.status === 'success' ? 'completed' : 'failed',
          typeof display === 'string' && display ? { text: display } : { rawOutput: response?.response })
      }
    ];
  }
  return [];
}

function userBlock(part: Record<string, unknown> | null): ContentBlock[] {
  if (typeof part?.text === 'string' && part.text && part.thought !== true) return [{ type: 'text', text: part.text }];
  const inline = asRecord(part?.inlineData);
  if (typeof inline?.data === 'string' && typeof inline.mimeType === 'string') {
    return [{ type: 'image', data: inline.data, mimeType: inline.mimeType }];
  }
  return [];
}

function assistantPart(part: Record<string, unknown> | null, messageId: string): NormalizedEvent | null {
  if (typeof part?.text === 'string' && part.text) {
    return part.thought === true
      ? { kind: 'thinking', messageId, text: part.text }
      : { kind: 'message', role: 'assistant', messageId, text: part.text };
  }
  const call = asRecord(part?.functionCall);
  if (call && typeof call.id === 'string') {
    const name = typeof call.name === 'string' ? call.name : 'tool';
    return toolCallStart(call.id, name, qwenToolKind(name), call.args);
  }
  return null;
}

/** qwen 内置工具名(`core/src/tools/tool-names.ts`)→ ACP ToolKind。名单外一律 'other'。 */
const qwenToolKind = toolKindTable({ read: ['read_file'], edit: ['edit', 'write_file'], execute: ['run_shell_command'], search: ['grep_search', 'glob', 'list_directory'], fetch: ['web_fetch', 'web_search'] });
