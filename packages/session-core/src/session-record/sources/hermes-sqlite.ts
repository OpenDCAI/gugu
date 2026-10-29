import Database from 'better-sqlite3';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';

import type { RecordBoundary, RecordEntry, SessionRecordLocator, SessionRecordSource } from '../contract';
import { asRecord, boundaryEntry, type SessionRecordSourceOptions, toolCallStart, toolCallResult, toolKindTable } from './shared';
import { SqlitePollSource, openSessionDb } from './sqlite-db';


type MessageRow = {
  id: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  tool_name: string | null;
  timestamp: number;
  finish_reason: string | null;
  reasoning: string | null;
  reasoning_content: string | null;
  display_kind: string | null;
};

/**
 * 看得见的行(Hermes `hermes_state.py` schema 30)。压缩是原地做的(#38763):被总结掉的原行留着
 * `active = 0, compacted = 1`,新插的总结行 `_compressed_summary = 1`;撤回 / 被压缩复制走的原行是
 * `active = 0, compacted = 0`(「人收回了」,Hermes 自己也不再显示)。
 */
const VISIBLE = 'session_id = ? and (active = 1 or compacted = 1) and _compressed_summary = 0';
const COLUMNS = 'id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, reasoning_content, display_kind';

/** Hermes 自己替人塞进对话的用户行(`tui_gateway/server.py` 的显示投影同样不把它们画成用户说的话)。 */
const SYNTHETIC_USER_KINDS = new Set(['hidden', 'model_switch', 'auto_continue', 'async_delegation_complete']);
const SYNTHETIC_USER_PREFIXES = ['[System:', '[System note: Your previous turn was interrupted mid-run'];

/** 多模态内容的落盘形状:`\0json:` 前缀 + JSON(`SessionDB._encode_content`)。 */
const CONTENT_JSON_PREFIX = '\u0000json:';

/** 这一轮还没收尾时,最后一行是什么 —— 下一句用户话到来、或会话结束时据它判结局。 */
type OpenTurn = { rowId: number; kind: 'user' | 'tool' | 'assistant_tools' | 'assistant_length' };

export function createHermesSqliteSource(locator: SessionRecordLocator, options?: SessionRecordSourceOptions): SessionRecordSource {
  return new HermesSqliteSource(locator, options);
}

/**
 * Hermes 的 `state.db`。只读打开 ❌ 走 ACP load(load 会清掉会话行的 `ended_at`)。
 *
 * 行只追加，按 `id` 递增读;回头改的只有两种(撤回、原地压缩),都表现为「已经发出去的行看不见了」,
 * 这时整份重来。
 * ⚠️ 只跟这一个会话 id:Hermes 关掉原地压缩(`compression_in_place: false`)时会另起一个子会话接着写,
 * 那之后的内容这里读不到。
 */
class HermesSqliteSource extends SqlitePollSource<SessionRecordLocator> {
  private watermark = 0;
  /** 已经发出去的可见行数。库里 `id <= watermark` 的可见行比它少 = 有行被收回了。 */
  private seen = 0;
  private openTurn: OpenTurn | null = null;

  constructor(locator: SessionRecordLocator, options?: SessionRecordSourceOptions) {
    super(locator, options, 'hermes');
  }

  protected open(): { db: Database.Database; dbPath: string } {
    return openSessionDb({ name: 'hermes state.db', dbPaths: this.locator.roots, table: 'sessions', sessionId: this.locator.providerSessionId });
  }

  protected read(): void {
    const { n } = this.db!
      .prepare(`select count(*) as n from messages where ${VISIBLE} and id <= ?`)
      .get(this.locator.providerSessionId, this.watermark) as { n: number };
    if (n < this.seen) {
      this.watermark = 0;
      this.seen = 0;
      this.openTurn = null;
      this.events!.onReset('source_replaced');
    }
    this.readNew();
  }

  private readNew(): void {
    const rows = this.db!.prepare(`select ${COLUMNS} from messages where ${VISIBLE} and id > ? order by id`).all(
      this.locator.providerSessionId,
      this.watermark
    ) as MessageRow[];
    const entries: RecordEntry[] = [];
    for (const row of rows) {
      this.watermark = row.id;
      this.seen += 1;
      entries.push(...this.decode(row));
    }
    // 会话关了(`ended_at`)还没收尾的那一轮,就停在了它最后一行的形状上。
    if (this.openTurn) {
      const session = this.db!.prepare('select ended_at from sessions where id = ?').get(this.locator.providerSessionId) as
        | { ended_at: number | null }
        | undefined;
      if (session?.ended_at != null) entries.push(this.close(this.openTurn, session.ended_at * 1000));
    }
    if (entries.length > 0) this.events!.onEntries(entries);
  }

  private close(open: OpenTurn, at: number): RecordEntry {
    this.openTurn = null;
    const boundary: RecordBoundary =
      open.kind === 'assistant_length' ? { kind: 'turn_end', stopReason: 'max_tokens' } : { kind: 'turn_aborted' };
    return boundaryEntry(`hermes:${open.rowId}`, at, boundary);
  }

  private decode(row: MessageRow): RecordEntry[] {
    const at = row.timestamp * 1000;
    const key = (index: number) => `hermes:${row.id}#${index}`;
    const out: RecordEntry[] = [];
    const push = (event: NormalizedEvent) => out.push({ key: key(out.length), at, event });
    const text = contentText(row.content);

    if (row.role === 'user') {
      if (isSyntheticUser(row, text)) return [];
      // 上一轮没收尾就来了下一句用户话 ⇒ 上一轮停在了它最后一行的形状上。
      if (this.openTurn) out.push(this.close(this.openTurn, at));
      if (text) push({ kind: 'message', role: 'user', messageId: key(0), text });
      this.openTurn = { rowId: row.id, kind: 'user' };
      return out;
    }

    if (row.role === 'tool') {
      if (row.tool_call_id) {
        push(toolCallResult(row.tool_call_id, 'completed', text ? { text } : {}));
      }
      this.openTurn = { rowId: row.id, kind: 'tool' };
      return out;
    }

    if (row.role !== 'assistant') return [];
    const thought = row.reasoning_content || row.reasoning;
    if (thought) push({ kind: 'thinking', messageId: key(0), text: thought });
    if (text) push({ kind: 'message', role: 'assistant', messageId: key(0), text });
    const calls = toolCallsOf(row.tool_calls);
    for (const call of calls) push(call);
    if (calls.length > 0) {
      this.openTurn = { rowId: row.id, kind: 'assistant_tools' };
      return out;
    }
    // 截断了 Hermes 会自己接着写(插一条 `[System: … truncated …]` 再续),不在这里收尾。
    if (row.finish_reason === 'length') {
      this.openTurn = { rowId: row.id, kind: 'assistant_length' };
      return out;
    }
    this.openTurn = null;
    // Hermes 自己把 `error` / `agent_error` / `content_filter` 都算作出错(`hermes_state.py` 的 finish_reason 分类);
    // 这里把 `content_filter` 细分成 ACP 的「被拒」(`refusal`),Hermes 的分类里没有这一档。
    const boundary: RecordBoundary =
      row.finish_reason === 'content_filter'
        ? { kind: 'turn_end', stopReason: 'refusal' }
        : row.finish_reason === 'error' || row.finish_reason === 'agent_error'
          ? { kind: 'turn_failed' }
          : { kind: 'turn_end', stopReason: 'end_turn' };
    out.push(boundaryEntry(`hermes:${row.id}`, at, boundary));
    return out;
  }
}

// ─── 映射 ────────────────────────────────────────────────────────────────────

function isSyntheticUser(row: MessageRow, text: string): boolean {
  if (row.display_kind && SYNTHETIC_USER_KINDS.has(row.display_kind)) return true;
  const head = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((prefix) => head.startsWith(prefix));
}

/** 字符串原样;多模态(`\0json:` + 片段数组)取其中的文本片段。 */
function contentText(content: string | null): string {
  if (!content) return '';
  if (!content.startsWith(CONTENT_JSON_PREFIX)) return content;
  let parts: unknown;
  try {
    parts = JSON.parse(content.slice(CONTENT_JSON_PREFIX.length));
  } catch {
    return content;
  }
  if (!Array.isArray(parts)) return '';
  return parts
    .map((part) => (typeof part === 'string' ? part : (asRecord(part)?.text as string | undefined) ?? ''))
    .filter(Boolean)
    .join('\n');
}

/** OpenAI 形状的 `tool_calls`(`[{id, function:{name, arguments}}]`,arguments 是 JSON 字符串)。 */
function toolCallsOf(raw: string | null): NormalizedEvent[] {
  if (!raw) return [];
  let calls: unknown;
  try {
    calls = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((value): NormalizedEvent[] => {
    const call = asRecord(value);
    const fn = asRecord(call?.function);
    if (typeof call?.id !== 'string') return [];
    const name = typeof fn?.name === 'string' ? fn.name : 'tool';
    let input: unknown = fn?.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // 原样留着字符串
      }
    }
    return [toolCallStart(call.id, name, hermesToolKind(name), input)];
  });
}

/** Hermes 内置工具名 → ACP ToolKind。名单外一律 'other'。 */
const hermesToolKind = toolKindTable({ execute: ['terminal'], read: ['read_file'], edit: ['write_file', 'patch'], search: ['search_files'], fetch: ['web_extract', 'web_search'] });
