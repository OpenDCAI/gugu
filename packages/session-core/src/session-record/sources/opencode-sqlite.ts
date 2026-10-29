import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { NormalizedEvent, NormalizedToolStatus } from '../../acp/reducer/normalized-event';

import type { RecordBoundary, RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import {
  boundaryEntry,
  asRecord,
  parseJson,
  type SessionRecordSourceOptions,
  toolCallStart,
  toolCallResult,
  toolKindTable
} from './shared';
import { SqlitePollSource, openSessionDb } from './sqlite-db';


type MessageRow = { id: string; time_created: number; time_updated: number; data: string };
type PartRow = {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  data: string;
};

/** 一个 part 上一次发出去的样子。用来判"这次轮询它变了没有"。 */
type PartState = {
  /** 已经发出去的文本长度（text / reasoning 用）。 */
  emittedText: string;
  /** 已经发出去的整份 data，原样比对；没变就不发第二遍。 */
  signature: string;
  /** 这个 part 已经发过几条 event —— 进 key 的后缀，保证同一份内容重发时 key 不冲突。 */
  emissions: number;
};

export function createOpencodeSqliteSource(
  locator: SessionRecordLocator,
  options?: SessionRecordSourceOptions
): SessionRecordSource {
  return new OpencodeSqliteSource(locator, options);
}

class OpencodeSqliteSource extends SqlitePollSource<SessionRecordLocator> {
  private roles = new Map<string, 'user' | 'assistant'>();
  private parts = new Map<string, PartState>();
  private watermark = 0;
  /** 「这一批读完之后要整份重来」。❌ 别在遍历中途直接重来：那会在自己的循环里再跑一遍自己。 */
  private pendingRestart: 'source_replaced' | 'source_unreadable' | null = null;
  private restarting = false;

  /**
   * `locator.agentId` 给了 ⇒ 只读这个 agent 的消息(mimocode 的子 agent 与主 agent 同住一个会话)。
   * part 表没有这一列，经它的消息筛;同一条 select 里筛,part 先于消息行被读到的那种竞态也就不存在。
   */
  private readonly messageFilter: string;
  private readonly partFilter: string;
  private readonly filterArgs: string[];

  constructor(locator: SessionRecordLocator, options?: SessionRecordSourceOptions) {
    super(locator, options, 'opencode');
    const agentId = locator.agentId;
    this.messageFilter = agentId ? ' and agent_id = ?' : '';
    this.partFilter = agentId ? ' and message_id in (select id from message where agent_id = ?)' : '';
    this.filterArgs = agentId ? [agentId] : [];
  }

  protected open(): { db: Database.Database; dbPath: string } {
    return openSessionDb({
      name: 'opencode',
      dbPaths: [...this.locator.roots, ...channelDbPaths(this.locator.channelDbs)],
      table: 'session',
      sessionId: this.locator.providerSessionId
    });
  }

  protected read(first: boolean): void {
    if (first) {
      this.readAll();
      return;
    }
    // `>=` 而不是 `>`:同一毫秒里写进来的行会被 `>` 整批漏掉，而「漏掉的那条正好是最后一条」
    // 在界面上就是永远差最后一句。重复读回来的行由 signature 挡住，代价只是一次字符串比对。
    const messages = this.db!.prepare(
      'select id, time_created, time_updated, data from message ' +
        `where session_id = ? and time_updated >= ?${this.messageFilter} order by time_created, id`
    ).all(this.locator.providerSessionId, this.watermark, ...this.filterArgs) as MessageRow[];
    const parts = this.db!.prepare(
      'select id, message_id, time_created, time_updated, data from part ' +
        `where session_id = ? and time_updated >= ?${this.partFilter} order by time_updated, time_created, id`
    ).all(this.locator.providerSessionId, this.watermark, ...this.filterArgs) as PartRow[];
    this.absorb(messages, parts);
  }

  /**
   * 整份重来：清空自己的记忆再从头读一遍。
   *
   * 契约里 onReset 的意思是"timeline 换 epoch 并整份重读"，而"整份重读"的活在源这一侧 ——
   * 只喊 onReset 不清 `parts`，下一次全量读会被 signature 全部挡回去，
   * 订阅者拿到的是一条**空**时间线。
   */
  private restart(reason: 'source_replaced' | 'source_unreadable'): void {
    this.roles.clear();
    this.parts.clear();
    this.watermark = 0;
    this.events?.onReset(reason);
    this.restarting = true;
    try {
      this.readAll();
    } finally {
      this.restarting = false;
    }
  }

  private readAll(): void {
    const messages = this.db!.prepare(
      'select id, time_created, time_updated, data from message ' +
        `where session_id = ?${this.messageFilter} order by time_created, id`
    ).all(this.locator.providerSessionId, ...this.filterArgs) as MessageRow[];
    const parts = this.db!.prepare(
      'select id, message_id, time_created, time_updated, data from part ' +
        `where session_id = ?${this.partFilter} order by time_created, id`
    ).all(this.locator.providerSessionId, ...this.filterArgs) as PartRow[];
    this.absorb(messages, parts);
  }

  private absorb(messages: MessageRow[], parts: PartRow[]): void {
    if (!this.events) return;
    let bad = 0;
    /** 这一批里了结了的 assistant 消息：messageId → 它的边界。 */
    const completed = new Map<string, Settled>();
    for (const row of messages) {
      this.watermark = Math.max(this.watermark, row.time_updated);
      const data = parseJson(row.data);
      if (!data) {
        bad += 1;
        continue;
      }
      const role = data.role;
      if (role === 'user' || role === 'assistant') this.roles.set(row.id, role);
      // 一条 assistant 消息写上 `time.completed` 或 `error` = 这一轮了结了。
      // ⚠️ 边界不能就地推：它必须排在这条消息**自己那些 part 之后**，否则会把还在写的那一轮提前关掉。
      const done = role === 'assistant' ? settledOf(data) : null;
      if (done !== null) completed.set(row.id, done);
    }

    const entries: RecordEntry[] = [];
    /** messageId → 它最后一条 part 在 entries 里的下标。边界插在这之后。 */
    const lastPartIndex = new Map<string, number>();
    for (const row of parts) {
      this.watermark = Math.max(this.watermark, row.time_updated);
      const data = parseJson(row.data);
      if (!data) {
        bad += 1;
        continue;
      }
      const decoded = this.decodePart(row, data);
      if (decoded) {
        entries.push(decoded);
        lastPartIndex.set(row.message_id, entries.length - 1);
      }
    }
    const ordered = withBoundaries(entries, lastPartIndex, completed);
    if (ordered.length > 0) this.events.onEntries(ordered);
    if (bad > 0) this.warn('opencode 的 data 列里有无法解析的 JSON，已跳过', { count: bad });

    const restart = this.pendingRestart;
    this.pendingRestart = null;
    if (restart && !this.restarting) this.restart(restart);
  }

  /**
   * 取这条 part 归属消息的角色。
   *
   * 缓存里没有就**当场补一次查询**：两条 select 之间新写进来的 part 会先于它的 message 行
   * 被读到，那时缓存是空的。缺省成 assistant 的话，用户自己说的话会被永久标成 agent 说的 ——
   * 而 signature 挡着不会重发，下一轮也纠不回来。
   */
  private roleOf(messageId: string): 'user' | 'assistant' | null {
    const cached = this.roles.get(messageId);
    if (cached) return cached;
    if (!this.db) return null;
    const row = this.db.prepare('select data from message where id = ?').get(messageId) as
      | { data: string }
      | undefined;
    const role = row ? parseJson(row.data)?.role : undefined;
    if (role !== 'user' && role !== 'assistant') return null;
    this.roles.set(messageId, role);
    return role;
  }

  private decodePart(row: PartRow, data: Record<string, unknown>): RecordEntry | null {
    const signature = row.data;
    const prior = this.parts.get(row.id);
    if (prior && prior.signature === signature) return null; // 没变，别重发

    const type = data.type;
    if (type === 'text' || type === 'reasoning') {
      return this.decodeStreamedText(row, data, type, prior, signature);
    }
    if (type === 'tool') {
      return this.decodeTool(row, data, prior, signature);
    }
    // step-start / step-finish 这类是计费与分段的账，不是会话内容。
    this.parts.set(row.id, { emittedText: '', signature, emissions: prior?.emissions ?? 0 });
    return null;
  }

  /**
   * 流式文本按**增量**发，不按全文发。
   *
   * reducer 对同一个 messageId 的消息是**追加**语义（item-fold 里 `msg.text + event.text`），
   * 所以把长大的全文再发一遍等于把前半段说两遍。这里只发新长出来的那一截。
   * 文本不再是旧文本的前缀 ⇒ 内容被改写过（回滚、重生成），增量无从表达，只能整份重来。
   */
  private decodeStreamedText(
    row: PartRow,
    data: Record<string, unknown>,
    type: 'text' | 'reasoning',
    prior: PartState | undefined,
    signature: string
  ): RecordEntry | null {
    // harness 替人塞进对话的字(技能清单、附件展开),不是谁说的话;opencode 自己的界面也跳过它们
    // (session-ui `message-part.tsx`、app `dialog-fork.tsx`)。mimocode 每轮都塞一段技能清单。
    if (data.synthetic === true || data.ignored === true) {
      this.parts.set(row.id, { emittedText: '', signature, emissions: prior?.emissions ?? 0 });
      return null;
    }
    const text = typeof data.text === 'string' ? data.text : '';
    const emitted = prior?.emittedText ?? '';
    if (text === emitted) {
      this.parts.set(row.id, { emittedText: emitted, signature, emissions: prior?.emissions ?? 0 });
      return null;
    }
    if (!text.startsWith(emitted)) {
      this.pendingRestart = 'source_replaced';
      return null;
    }
    const delta = text.slice(emitted.length);
    if (delta.length === 0) return null;

    const emissions = prior?.emissions ?? 0;
    const key = emissions === 0 ? `opencode:${row.id}` : `opencode:${row.id}#${emissions}`;
    this.parts.set(row.id, { emittedText: text, signature, emissions: emissions + 1 });

    const messageId = `opencode:${row.id}`;
    const event: NormalizedEvent = type === 'reasoning'
      ? { kind: 'thinking', messageId, text: delta }
      : { kind: 'message', role: this.roleOf(row.message_id) === 'user' ? 'user' : 'assistant', messageId, text: delta };
    return { key, at: row.time_created, event };
  }

  private decodeTool(
    row: PartRow,
    data: Record<string, unknown>,
    prior: PartState | undefined,
    signature: string
  ): RecordEntry | null {
    const callId = typeof data.callID === 'string' ? data.callID : row.id;
    const tool = typeof data.tool === 'string' ? data.tool : 'tool';
    const state = asRecord(data.state);
    const status = mapToolStatus(state?.status);
    const output = status === 'failed' ? state?.error : state?.output;
    const hasAttachments = Array.isArray(state?.attachments) && state.attachments.length > 0;
    const result = hasAttachments ? { output, attachments: state.attachments, metadata: state.metadata } : output;
    // Replace an earlier text projection when a later observation includes attachments.
    const displayed = hasAttachments ? JSON.stringify(result, null, 2) : output;


    const emissions = prior?.emissions ?? 0;
    const key = emissions === 0 ? `opencode:${row.id}` : `opencode:${row.id}#${emissions}`;
    this.parts.set(row.id, { emittedText: '', signature, emissions: emissions + 1 });

    // Pending starts with empty input; later observations must carry the completed arguments.
    const resultEvent = toolCallResult(callId, status, {
      rawInput: state?.input,
      ...(result !== undefined && (hasAttachments || typeof result !== 'string') ? { rawOutput: result } : {}),
      ...(typeof displayed === 'string' ? { text: displayed } : {}),
    });
    const event: NormalizedEvent = emissions === 0
      ? {
          ...toolCallStart(callId, tool, opencodeToolKind(tool), state?.input), status,
          ...(resultEvent.rawOutput != null ? { rawOutput: resultEvent.rawOutput } : {}),
          ...(resultEvent.outputText != null ? { outputText: resultEvent.outputText } : {}),
        }
      : resultEvent;
    return { key, at: row.time_created, event };
  }
}

type Settled = { at?: number; boundary: RecordBoundary };

/**
 * 一条 assistant 消息是不是这一轮的结尾。
 *
 * opencode 的一轮是好几条 assistant 消息(每一步一条),每条都盖完成戳 `time.completed`;
 * 只看完成戳会把一句话切成好几轮。还要接着干的那一步写 `finish: tool-calls`,不是结尾。
 * 出错的消息是终态(mimocode 有一部分出错消息不盖完成戳,mac1 真库 APIError 7 行里 2 行):
 * `MessageAbortedError` 是打断，其余是失败。
 */
function settledOf(data: Record<string, unknown>): Settled | null {
  const value = asRecord(data.time)?.completed;
  const at = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const stamp = at !== undefined ? { at } : {};
  const error = asRecord(data.error);
  if (error) return { ...stamp, boundary: error.name === 'MessageAbortedError' ? { kind: 'turn_aborted' } : { kind: 'turn_failed' } };
  if (at === undefined || data.finish === 'tool-calls') return null;
  return { ...stamp, boundary: { kind: 'turn_end', stopReason: data.finish === 'length' ? 'max_tokens' : 'end_turn' } };
}

/**
 * 把边界插进内容流：每条已完成消息的边界紧跟它最后一条 part。
 *
 * ⚠️ 一律追加到批尾是**不行**的：首轮整份读会把整个会话装进一批，那样所有边界都排在
 * 最后一条 part 之后 —— 第一条关掉的是最后一轮，剩下的成了空操作，中间那些轮的结局就丢了。
 * 这一批里没有任何 part 的已完成消息（它的 part 在更早一批里读过了）排在批尾，
 * 那是它相对本批内容唯一说得通的位置。
 */
function withBoundaries(
  entries: RecordEntry[],
  lastPartIndex: Map<string, number>,
  completed: Map<string, Settled>
): RecordEntry[] {
  if (completed.size === 0) return entries;
  type Item = Settled & { messageId: string };
  const afterIndex = new Map<number, Item[]>();
  const trailing: Item[] = [];
  for (const [messageId, settled] of completed) {
    const item = { messageId, ...settled };
    const index = lastPartIndex.get(messageId);
    if (index === undefined) {
      trailing.push(item);
      continue;
    }
    const bucket = afterIndex.get(index);
    if (bucket) bucket.push(item);
    else afterIndex.set(index, [item]);
  }
  const boundaryOf = (item: Item): RecordEntry => boundaryEntry(`opencode:${item.messageId}`, item.at, item.boundary);
  const out: RecordEntry[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    out.push(entries[i]);
    for (const item of afterIndex.get(i) ?? []) out.push(boundaryOf(item));
  }
  for (const item of trailing) out.push(boundaryOf(item));
  return out;
}

/** 目录里按通道分的库 `<app>-<通道>.db`(不含 `-wal` / `-shm`)。目录不在就是没有。 */
function channelDbPaths(channelDbs: SessionRecordLocator['channelDbs']): string[] {
  if (!channelDbs) return [];
  const prefix = `${channelDbs.app}-`;
  return channelDbs.dirs.flatMap((dir) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter((name) => name.startsWith(prefix) && name.endsWith('.db')).sort().map((name) => join(dir, name));
  });
}

function mapToolStatus(status: unknown): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
    case 'failed':
      return 'failed';
    case 'running':
      return 'in_progress';
    default:
      return 'pending';
  }
}

/** opencode 的工具名是小写动词。名单外一律 'other'，理由同 claude 侧。 */
const opencodeToolKind = toolKindTable({ read: ['read'], edit: ['edit', 'write', 'patch'], execute: ['bash'], search: ['grep', 'glob', 'list'], fetch: ['webfetch'] });
