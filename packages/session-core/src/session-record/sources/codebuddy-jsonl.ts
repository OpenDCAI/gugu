import { join } from 'node:path';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import { isSessionContextText } from '../../acp/session-context';

import type { RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { findUnder } from './find-file';
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
import { createTreeJsonlSource, type TreeNode } from './tree-jsonl';

/**
 * CodeBuddy Code 的会话记录(2.179.3 实测):`<根>/projects/<工作目录改写>/<会话 id>.jsonl`,每行一条，
 * 形状是 OpenAI Agents 的 run item(`message` / `reasoning` / `function_call` / `function_call_result`),
 * 经 `id` / `parentId` 连成一条链。`session-meta`、`file-history-snapshot`、`ai-title`、`summary`、
 * `turn-metrics` 不是对话内容，也不在链上。
 */
export function createCodebuddyJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return createTreeJsonlSource(locator, options, () => resolveSessionFile(locator), {
    name: 'codebuddy',
    toNode: (raw) =>
      typeof raw.id === 'string' && typeof raw.type === 'string' && CONVERSATION_TYPES.has(raw.type)
        ? { id: raw.id, parentId: typeof raw.parentId === 'string' ? raw.parentId : null, raw }
        : null,
    decode
  });
}

const CONVERSATION_TYPES = new Set(['message', 'reasoning', 'function_call', 'function_call_result']);

// ─── 定位 ────────────────────────────────────────────────────────────────────

/** 工作目录改写(`/` 换成 `-`)宿主不重算：按会话 id 在每个项目目录里找就是唯一的。 */
async function resolveSessionFile(locator: SessionRecordLocator): Promise<string> {
  const name = `${locator.providerSessionId}.jsonl`;
  const hit = await findUnder(locator.roots, '', name);
  if (hit) return hit;
  throw new SessionRecordNotFoundError(
    `找不到 codebuddy 会话记录：sessionId=${locator.providerSessionId}`,
    locator.roots.map((root) => join(root, '*', name))
  );
}

// ─── 映射 ────────────────────────────────────────────────────────────────────

function decode(node: TreeNode): RecordEntry[] {
  const record = node.raw;
  const at = parseTimestamp(record.timestamp);
  const stamp = at !== undefined ? { at } : {};
  const key = (index: number) => `codebuddy:${node.id}#${index}`;
  const entries = (events: NormalizedEvent[]): RecordEntry[] =>
    events.map((event, index) => ({ key: key(index), ...stamp, event }));

  if (record.type === 'message' && record.role === 'user') {
    if (!isRealUserMessage(record)) return [];
    return entries(texts(record.content, 'input_text').filter(isPersonText)
      .map((text) => ({ kind: 'message', role: 'user', messageId: node.id, text })));
  }

  if (record.type === 'message' && record.role === 'assistant') {
    const out = entries(texts(record.content, 'output_text')
      .map((text) => ({ kind: 'message', role: 'assistant', messageId: node.id, text })));
    // 一轮的收尾:一步(一次模型应答)的最后一条带着这一步的 `message.usage`;最后一条是正文而不是
    // `function_call` ⇒ 这一步没有工具要跑，这一轮到此为止。同一步里先说话再调工具时，正文那条不带 usage。
    // 被打断的轮盘上没有记号，由下一句话关上。
    if (asRecord(record.message)?.usage) {
      const step = asRecord(record.providerData)?.messageId;
      out.push(boundaryEntry(`codebuddy:${node.id}`, at, {
        kind: 'turn_end', stopReason: 'end_turn', ...(typeof step === 'string' ? { messageId: step } : {})
      }));
    }
    return out;
  }

  if (record.type === 'reasoning') {
    const raw = texts(record.rawContent, 'reasoning_text');
    return entries((raw.length > 0 ? raw : texts(record.content, 'summary_text'))
      .map((text) => ({ kind: 'thinking', messageId: node.id, text })));
  }

  if (record.type === 'function_call' && typeof record.callId === 'string') {
    const name = typeof record.name === 'string' ? record.name : 'tool';
    return entries([toolCallStart(record.callId, name, codebuddyToolKind(name), parseArguments(record.arguments))]);
  }

  if (record.type === 'function_call_result' && typeof record.callId === 'string') {
    const text = outputText(record.output);
    return entries([toolCallResult(record.callId, record.status === 'completed' ? 'completed' : 'failed',
      text !== null ? { text } : { rawOutput: record.output })]);
  }
  return [];
}

/**
 * CodeBuddy 自己替人塞的用户行不当人说的话(它自己读历史时同一个判法,`isRealUserMessageItem`):
 * 跳过不跑的、压缩出来的、队友转来的。
 */
function isRealUserMessage(record: Record<string, unknown>): boolean {
  const data = asRecord(record.providerData);
  return !data?.skipRun && data?.isCompactInternal !== true && data?.isCompacted !== true && data?.isSummary !== true
    && typeof data?.compactType !== 'string' && data?.isMeta !== true && typeof asRecord(data?.teammateMessage)?.from !== 'string';
}

/** 首轮输入里不是人说的那几块:咕咕的会话级背景(③)和 CodeBuddy 自己插的 `<system-reminder>`。 */
function isPersonText(text: string): boolean {
  return !isSessionContextText(text) && !/^\s*<system-reminder\b/.test(text);
}

function texts(content: unknown, type: string): string[] {
  if (typeof content === 'string') return content ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = asRecord(part);
    return block?.type === type && typeof block.text === 'string' && block.text ? [block.text] : [];
  });
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * `output` 是 `{ type: 'text', text }`(也见过裸字符串);MCP 工具的 `text` 里还套着一层 JSON 化的内容块数组
 * (`[{"type":"text","text":"replied (id=msg:…)"}]`),拆成正文 —— 发送回执要从正文里认消息 id。
 */
function outputText(output: unknown): string | null {
  const text = typeof output === 'string' ? output : asRecord(output)?.type === 'text' ? asRecord(output)!.text : null;
  if (typeof text !== 'string') return null;
  try {
    const blocks = JSON.parse(text) as unknown;
    if (Array.isArray(blocks) && blocks.length > 0 && blocks.every((block) => asRecord(block)?.type === 'text')) {
      return blocks.map((block) => String(asRecord(block)!.text ?? '')).join('\n');
    }
  } catch {
    // 不是内容块数组：原样就是正文。
  }
  return text;
}

/** CodeBuddy 内置工具用 Claude Code 的名字(发行包 2.179.3 里核过)。名单外(含 `mcp__*`)一律 'other'。 */
const codebuddyToolKind = toolKindTable({ read: ['Read'], edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'], execute: ['Bash', 'BashOutput', 'KillShell'], search: ['Grep', 'Glob'], fetch: ['WebFetch', 'WebSearch'] });
