import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { readCodexRecord, type CodexRecord, type CodexRecordItem } from '@gugu/core/local/agent/transcriptSources/codex';
import { subagentUpdate } from '@gugu/core/shared/subagentUpdates.mjs';

import type { RecordEntry, SessionRecordLocator, SessionRecordSource, SessionRecordResume } from '../contract';
import { createJsonlTailSource } from './jsonl-tail-source';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  parseTimestamp,
  toJsonValue,
  type SessionRecordSourceOptions,
  toolCallStart,
  toolKindTable
} from './shared';


/** 目录并发下钻宽度。codex 按 年/月/日 分层，一台常用机上有几千个日期目录(本机实测 34882 份 rollout)。 */
const DIR_CONCURRENCY = 16;

/**
 * 一条记录在链上的位置。
 *
 * key 用**序号**而不是 codex 自己的 id:`--resume` 后 codex 会把 item id 重编号，
 * 拿它当身份键会让同一件事在恢复前后各算一次(历史直接翻倍)。序号只由「这份文件从头数到这里」
 * 决定，同一份文件读多少遍都一样;续读时随续读点装回去，接着数。
 */
type Child = { id: string; name: string; callId: string; task?: string; model?: string };
type Ordinals = { turn: number; item: number; calls: Record<string, Record<string, unknown>>; children: Record<string, Child> };

export function createCodexJsonlSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions, nativeChild = false): SessionRecordSource {
  const children = new Map<string, SessionRecordSource>();
  const starting = new Map<string, Promise<void>>();
  let stopped = false;
  let sink: import('../contract').SessionRecordSourceEvents | null = null;
  let currentState: Ordinals | null = null;
  let initializing = true;
  let replacement: SessionRecordSource | null = null;
  let childResumes: Record<string, SessionRecordResume> = {};
  const restart = async (reason: 'source_replaced' | 'source_unreadable') => {
    if (stopped || replacement || !sink) return;
    root.stop();
    for (const source of children.values()) source.stop();
    children.clear();
    sink.onReset(reason);
    replacement = createCodexJsonlSource(locator, options, nativeChild);
    await replacement.start(sink);
  };
  const ensureChild = (child: Child): Promise<void> => {
    if (stopped || children.has(child.id)) return Promise.resolve();
    const pending = starting.get(child.id);
    if (pending) return pending;
    const source = createCodexJsonlSource({ ...locator, providerSessionId: child.id }, options, true);
    children.set(child.id, source);
    const read = source.start({
      onEntries(entries) {
        const mapped: RecordEntry[] = entries.flatMap((entry): RecordEntry[] => {
          if (entry.boundary) return [{ key: entry.key, at: entry.at, update: subagentUpdate({
            sessionUpdate: 'subagent_state_update', subagentSessionId: child.id,
            state: entry.boundary.kind === 'turn_failed' ? 'failed' : entry.boundary.kind === 'turn_aborted' ? 'cancelled' : 'completed',
          }) }];
          const inner = entry.update._meta?.['gugu.draftSessionUpdate'] as { sessionUpdate?: string; parentToolCallId?: string } | undefined;
          if (inner?.sessionUpdate === 'subagent_spawned' && !inner.parentToolCallId) inner.parentToolCallId = child.id;
          if (inner) return [entry];
          if (entry.update.sessionUpdate === 'user_message_chunk') return [{ key: entry.key, at: entry.at, update: subagentUpdate({
            sessionUpdate: 'subagent_state_update', subagentSessionId: child.id, state: 'running', canCancel: false,
          }) }];
          return [{ ...entry, update: subagentUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: child.id, update: entry.update }) }];
        });
        if (!stopped) sink?.onEntries(mapped);
      },
      onReset: (reason) => { void restart(reason).catch((error: unknown) => options?.warn?.('Codex 子线程记录重读失败', { error: String(error) })); },
    }, childResumes[child.id]).catch((error: unknown) => {
      children.delete(child.id);
      options?.warn?.('Codex 子线程记录读取失败', { threadId: child.id, error: String(error) });
      throw error;
    }).finally(() => starting.delete(child.id));
    starting.set(child.id, read);
    return read;
  };
  const root = createJsonlTailSource<Ordinals>(locator, options, {
    name: 'codex',
    resumeVersion: 5,
    resolve: () => resolveRolloutFile(locator),
    initial: () => ({ turn: 0, item: -1, calls: {}, children: {} }),
    decode(record, ordinals) {
      currentState = ordinals;
      const codex = readCodexRecord(record);
      // 序号按**每一条记录**推进，不按「解出了 update 的记录」推进:
      // 这样以后给某个记录类型补上解码，已有 key 不会整体错位。
      ordinals.item += 1;
      if (codex.turnStart) {
        ordinals.turn += 1;
        ordinals.item = 0;
      }
      const key = `codex:${locator.providerSessionId}:${ordinals.turn}:${ordinals.item}`;
      if (nativeChild && codex.turnStart) return [{ key, at: parseTimestamp(codex.timestamp), update: subagentUpdate({
        sessionUpdate: 'subagent_state_update', subagentSessionId: locator.providerSessionId, state: 'running', canCancel: false,
      }) }];
      const item = codex.item;
      if (item?.kind === 'tool_call' && item.namespace === 'collaboration') {
        let input = item.input;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
        if (asRecord(input)) ordinals.calls[item.id] = { ...asRecord(input), name: item.name };
        return [];
      }
      if (item?.kind === 'tool_result' && ordinals.calls[item.callId]) return [];
      if (item?.kind === 'subagent') {
        const input = ordinals.calls[item.id] ?? {};
        const child = ordinals.children[item.threadId] ?? {
          id: item.threadId, name: item.name, callId: item.id,
          ...(typeof input.message === 'string' ? { task: input.message } : {}),
          ...(typeof input.model === 'string' ? { model: input.model } : {}),
        };
        const first = !ordinals.children[item.threadId];
        ordinals.children[item.threadId] = child;
        const at = parseTimestamp(codex.timestamp);
        const updates: SessionUpdate[] = [];
        if (first) updates.push(subagentUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: child.id,
          name: child.name, task: child.task ?? child.name, request: child.task, model: child.model,
          launchToolCallId: child.callId, background: true, capabilities: { cancel: false },
        }));
        // Lifecycle comes from the child's own task boundaries below. Replaying the parent's
        // activity summary as well would complete it before its history, then complete it twice.
        return updates.map((update, index) => ({ key: `${key}#${index}`, at, update }));
      }
      const entry = decode(codex, key);
      return entry ? [entry] : [];
    }
  });
  return {
    locator,
    async start(events, resume) {
      sink = events;
      const saved = resume?.data as { codexChildren?: number; root?: SessionRecordResume; children?: Record<string, SessionRecordResume> } | undefined;
      const rootResume = saved?.codexChildren === 1 ? saved.root : resume;
      childResumes = saved?.codexChildren === 1 ? saved.children ?? {} : {};
      await root.start({ ...events, onReset(reason) {
        for (const child of children.values()) child.stop();
        children.clear();
        events.onReset(reason);
      }, onEntries(entries) {
        events.onEntries(entries);
        // Spawn records are delivered before the child's records, so the shared parser can resolve their owner.
        if (!initializing && currentState) for (const child of Object.values(currentState.children)) {
          void ensureChild(child).catch((error: unknown) => events.onEntries([{ key: `codex-child-error:${child.id}`, update: subagentUpdate({
            sessionUpdate: 'subagent_state_update', subagentSessionId: child.id, state: 'disconnected', summary: String(error),
          }) }]));
        }
      } }, rootResume);
      const point = await root.resumePoint?.();
      currentState = (point?.data as { state?: Ordinals } | undefined)?.state ?? currentState;
      initializing = false;
      if (currentState) await Promise.all(Object.values(currentState.children).map(ensureChild));
      await Promise.all(starting.values());
    },
    async catchUp() { if (replacement) return replacement.catchUp?.(); await root.catchUp?.(); await Promise.all(starting.values()); await Promise.all([...children.values()].map((child) => child.catchUp?.())); },
    async resumePoint() {
      if (replacement) return replacement.resumePoint!();
      const point = await root.resumePoint!();
      if (!point) return null;
      const childPoints: Record<string, SessionRecordResume> = {};
      for (const [id, child] of children) {
        const value = await child.resumePoint?.();
        if (value) childPoints[id] = value;
      }
      return { data: { codexChildren: 1, root: point, children: childPoints }, fingerprint: [point.fingerprint, ...Object.entries(childPoints).sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => `${id}:${value.fingerprint}`)].join('|') };
    },
    stop() { stopped = true; replacement?.stop(); root.stop(); for (const child of children.values()) child.stop(); children.clear(); },
  };
}

function decode(record: CodexRecord, key: string): RecordEntry | null {
  const at = parseTimestamp(record.timestamp);
  if (record.end) {
    return boundaryEntry(
      key,
      at,
      record.end === 'aborted'
        ? { kind: 'turn_aborted' }
        : record.end === 'failed'
          ? { kind: 'turn_failed' }
          : { kind: 'turn_end', stopReason: 'end_turn' }
    );
  }
  if (!record.item) return null;
  return { key, ...(at !== undefined ? { at } : {}), update: toUpdate(record.item, key) };
}

// ─── 定位 ────────────────────────────────────────────────────────────────────

/**
 * 找 `<sessionRoot>/<年>/<月>/<日>/rollout-<时间戳>-<threadId>.jsonl`。
 *
 * 日期目录并发下钻的做法照抄 `packages/core/src/local/agent/transcriptInventory.ts`：
 * 串行递归光 readdir 就要几秒，那是"打开会话"这件事最大的一块墙钟。
 */
async function resolveRolloutFile(locator: SessionRecordLocator): Promise<string> {
  const suffix = `-${locator.providerSessionId}.jsonl`;
  for (const root of locator.roots) {
    const hit = await findBySuffix(root, suffix);
    if (hit) return hit;
  }
  throw new SessionRecordNotFoundError(
    `找不到 codex rollout 记录：threadId=${locator.providerSessionId}`,
    locator.roots.map((root) => join(root, '**', `rollout-*${suffix}`))
  );
}

async function findBySuffix(root: string, suffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null; // 这一家没装 / 根目录不在，不是错误
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) subdirs.push(path);
    else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) {
      return path;
    }
  }

  let cursor = 0;
  let found: string | null = null;
  await Promise.all(
    Array.from({ length: Math.min(DIR_CONCURRENCY, subdirs.length) }, async () => {
      while (cursor < subdirs.length && !found) {
        const nested = await findBySuffix(subdirs[cursor++], suffix);
        if (nested) found = nested;
      }
    })
  );
  return found;
}

// ─── 映射 ────────────────────────────────────────────────────────────────────
// 一行记录是什么意思由 core 的 `readCodexRecord` 读（导入清单读的是同一份）；这里只映射成 ACP update。

function toUpdate(item: CodexRecordItem, messageId: string): SessionUpdate {
  switch (item.kind) {
    case 'text': {
      const content = { type: 'text' as const, text: item.text };
      return item.role === 'user'
        ? { sessionUpdate: 'user_message_chunk', content, messageId }
        : { sessionUpdate: 'agent_message_chunk', content, messageId };
    }
    case 'thinking':
      return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: item.text }, messageId };
    case 'subagent':
      throw new Error('Codex subagent activity must be decoded with its source state');
    case 'tool_call':
      return toolCallStart(item.id, item.name, codexToolKind(item.name), item.input);
    case 'tool_result': {
      const text = typeof item.output === 'string' ? item.output : null;
      // An MCP tool's result is recorded as input items (`input_text`, `input_image`): its text and pictures go as ACP
      // content blocks, as the live ACP stream has them (148 10-14) — the card reads them there.
      const blocks = Array.isArray(item.output) ? item.output.flatMap(codexResultBlock) : [];
      // The output is held once: a result whose every item became a block is not kept again as rawOutput (6 MB of
      // pictures stored twice, review 10f3ea946c); one with an item no block carries stays disclosed whole, as the
      // claude source does (#6020).
      const carried = Array.isArray(item.output) && blocks.length > 0 && blocks.length === item.output.length;
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: item.callId,
        status: item.failed ? 'failed' : 'completed',
        ...(text !== null
          ? { content: [{ type: 'content' as const, content: { type: 'text' as const, text } }] }
          : blocks.length > 0
            ? { content: blocks.map((block) => ({ type: 'content' as const, content: block })) }
            : {}),
        ...(item.output !== undefined && text === null && !carried ? { rawOutput: toJsonValue(item.output) } : {})
      };
    }
  }
}

/** One recorded input item of a tool's result as an ACP content block: its text, or its picture (a `data:` URL). */
function codexResultBlock(item: unknown): Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> {
  const record = asRecord(item);
  if (record?.type === 'input_text' && typeof record.text === 'string') return [{ type: 'text', text: record.text }];
  const url = record?.type === 'input_image' && typeof record.image_url === 'string' ? record.image_url : '';
  const picture = /^data:([^;,]+);base64,(.+)$/.exec(url);
  return picture ? [{ type: 'image', mimeType: picture[1], data: picture[2] }] : [];
}

/** codex 的工具名 → ACP ToolKind。名单外一律 'other'，理由同 claude 侧。 */
const codexToolKind = toolKindTable({ execute: ['shell', 'local_shell', 'exec_command'], edit: ['apply_patch', 'write_file'], read: ['read_file'], fetch: ['web_search', 'web_fetch'] });
