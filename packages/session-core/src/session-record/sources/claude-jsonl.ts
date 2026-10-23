import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import { readClaudeRecord, type ClaudeRecordItem } from '@gugu/core/local/agent/transcriptSources/claudeCode';

import {
  type RecordEntry,
  type SessionRecordLocator,
  type SessionRecordResume,
  type SessionRecordSource,
  type SessionRecordSourceEvents
} from '../contract';
import { findUnder, isFile } from './find-file';
import {
  SessionRecordNotFoundError,
  asRecord,
  boundaryEntry,
  emitJsonLines,
  parseJson,
  parseTimestamp,
  pollInterval,
  warnOf,
  type RecordSourceWarn,
  type SessionRecordSourceOptions,
  toolCallResult,
  toolCallStart,
  toolKindTable
} from './shared';
import { TailReader, type TailResume } from './tail-reader';


/** 续读点里那份 claude 自己的数据。形状或读法变了就升版本号,老存档一律作废重读。 */
const CLAUDE_RESUME_VERSION = 3;
type ClaudeResumeData = {
  version: number;
  primaryPath: string;
  tailPath: string;
  tail: TailResume;
  seenUuids: string[];
  lastUuid: string | null;
};

/** 分叉扫描的候选上限。超了就报出去 —— ❌ 不许静默截断后当作"没有分叉"。 */
const FORK_CANDIDATE_LIMIT = 128;

/** 分叉链最长跳数。真实场景 1-2 跳；给上限是为了让"记录互相引用成环"不会变成死循环。 */
const FORK_MAX_HOPS = 8;

/** 首条消息之前只有几行元数据；读到这么多行还没见到消息就当它不是续写。 */
const HEAD_SCAN_MAX_LINES = 50;

export function createClaudeJsonlSource(
  locator: SessionRecordLocator,
  options?: SessionRecordSourceOptions
): SessionRecordSource {
  return new ClaudeJsonlSource(locator, options);
}

class ClaudeJsonlSource implements SessionRecordSource {
  private readonly warn: RecordSourceWarn;
  private events: SessionRecordSourceEvents | null = null;
  private reader: TailReader | null = null;
  private seenUuids = new Set<string>();
  /** 定位出来的那份主文件（分叉链的头）。续读点靠它判「还是不是同一条会话」。 */
  private primaryPath: string | null = null;
  /** 链条当前的末端记录。分叉串联只认它，所以要显式跟着走，❌ 别指望从 Set 里"最后一个"捞。 */
  private lastUuid: string | null = null;
  /**
   * 已读链条的「锚」：第一条消息的 uuid + 每个压缩点（`compact_boundary`）的 uuid。续写把祖先
   * 从开头、或压缩后从最近的压缩点起原样抄过去（claude 2.1.266 实测），所以它的首条消息必落在锚里。
   */
  private anchors = new Set<string>();
  private stopped = false;

  constructor(
    readonly locator: SessionRecordLocator,
    private readonly options?: SessionRecordSourceOptions
  ) {
    this.warn = warnOf(options);
  }

  async start(events: SessionRecordSourceEvents, resume?: SessionRecordResume): Promise<void> {
    this.events = events;
    const path = await resolveSessionFile(this.locator);
    this.primaryPath = path;
    this.reader = new TailReader(
      path,
      pollInterval(this.options),
      {
        onLines: (lines) => this.emitLines(lines),
        onRestart: (reason) => {
          // 先清去重表再转发：TailReader 在 onRestart 之后紧接着把整份文件当"新行"送进来，
          // 不清的话每一条都会撞上 seenUuids 被丢掉 —— 订阅者拿到一条空时间线。
          this.seenUuids = new Set();
          this.lastUuid = null;
          this.anchors = new Set();
          events.onReset(reason);
        }
      },
      this.warn
    );
    const resumed = resume ? await this.resumeRead(path, resume) : false;
    if (!resumed) {
      // 要过存档、却没能续上 ⇒ **必须**显式告诉上层「你手里装回去的那份作废」。
      // 不说的话:上层带着存档里的去重表,把整份重读的内容一条不剩地当成重复丢掉,
      // 屏幕上就留下一份**过期且永远不会再更新**的历史 —— 不报错、看不出来。
      if (resume) events.onReset('source_replaced');
      await this.fullRead(path);
    }
    this.reader.start();
  }

  /**
   * 接着上次读。任何一处对不上就返回 false，由调用方整份重读。
   *
   * ⚠️ 续读点里记着当时尾读盯的是**分叉链末端**那份文件；只有链末还是同一份、
   * inode/大小/mtime 都对得上，才能接着读。链变了就整份重来 —— 分叉意味着历史被改写过，
   * 拿旧偏移量往下读会拼出一份缺了中间的记录，而它不报错。
   */
  private async resumeRead(path: string, resume?: SessionRecordResume): Promise<boolean> {
    const data = resume?.data as ClaudeResumeData | undefined;
    if (!data || data.version !== CLAUDE_RESUME_VERSION) return false;
    if (data.primaryPath !== path) return false;
    // 链末先自己走一遍：它要是变了，说明中间出现过新的分叉文件。
    const tailPath = await this.chainForks(path).catch(() => null);
    if (tailPath === null || tailPath !== data.tailPath) return false;
    if (tailPath !== path) this.reader!.retarget(tailPath);
    this.seenUuids = new Set(data.seenUuids);
    this.lastUuid = data.lastUuid;
    const ok = await this.reader!.resumeFrom(data.tail, (lines) => this.emitLines(lines));
    if (!ok) {
      // 尾读器判定续不上（inode 换了 / 文件变短 / 读不到）。把刚装回去的去重表清掉，
      // 交给调用方统一走「作废 + 整份重读」那条路。
      this.seenUuids = new Set();
      this.lastUuid = null;
      return false;
    }
    return true;
  }

  async resumePoint(): Promise<SessionRecordResume | null> {
    // 存档在拆除时取,紧接着同步 stop() 把 this.reader 置空 —— await 之后只认这一刻的 reader。
    const reader = this.reader;
    if (!reader || !this.primaryPath) return null;
    const tail = await reader.resumePoint();
    if (!tail) return null;
    const data: ClaudeResumeData = {
      version: CLAUDE_RESUME_VERSION,
      primaryPath: this.primaryPath,
      tailPath: reader.currentPath,
      tail,
      seenUuids: [...this.seenUuids],
      lastUuid: this.lastUuid
    };
    return {
      data,
      fingerprint: `claude:${this.primaryPath}:${tail.ino}:${tail.size}:${tail.mtimeMs}`
    };
  }

  async catchUp(): Promise<void> {
    await this.reader?.catchUp();
  }

  stop(): void {
    this.stopped = true;
    this.reader?.stop();
    this.reader = null;
    this.events = null;
  }

  private async fullRead(path: string): Promise<void> {
    this.seenUuids = new Set();
    this.lastUuid = null;
    this.anchors = new Set();
    await this.reader!.readFromStart((lines) => this.emitLines(lines));
    // 分叉串联接在整份读之后：串上来的那份也是"已有内容"，尾读要交接到链条最后一份上。
    const tailPath = await this.chainForks(path);
    if (tailPath !== path) this.reader!.retarget(tailPath);
  }

  private emitLines(lines: string[]): void {
    if (this.stopped || !this.events) return;
    const events = this.events;
    emitJsonLines(lines, 'claude', this.warn, (entries) => events.onEntries(entries), (record) => this.decodeRecord(record));
  }

  private decodeRecord(record: Record<string, unknown>): RecordEntry[] {
    const uuid = typeof record.uuid === 'string' ? record.uuid : null;
    if (!uuid) return [];
    // 同 uuid 只算一次：分叉出来的新文件把祖先记录**原样连 uuid 一起**抄了一份，
    // 串联时不去重就会把整段历史再演一遍。
    if (this.seenUuids.has(uuid)) return [];
    if (this.seenUuids.size === 0 || record.subtype === 'compact_boundary') this.anchors.add(uuid);
    this.seenUuids.add(uuid);
    this.lastUuid = uuid;
    return decodeClaudeRecord(record, uuid);
  }

  /**
   * 沿 leaf 往后串分叉文件。
   *
   * `--fork-session` 产生的是**另一个 sessionId 的新文件**，里面把祖先那条路径连 uuid 一起抄了过来。
   * 所以判据是「这份候选里含不含我这份的 leaf uuid」：含 ⇒ 它是我的续写；不含 ⇒ 它是从更早的点
   * 岔出去的兄弟分叉，串上来就是把两条互不相干的对话缝成一条。
   */
  private async chainForks(basePath: string): Promise<string> {
    let currentPath = basePath;
    let leaf = this.lastUuid;
    const visited = new Set<string>([basePath]);

    for (let hop = 0; hop < FORK_MAX_HOPS; hop += 1) {
      if (!leaf) return currentPath;
      const next = await this.findContinuation(currentPath, leaf, visited);
      if (!next) return currentPath;
      visited.add(next.path);
      this.emitLines(next.lines);
      const newLeaf = this.lastUuid;
      if (newLeaf === leaf) return currentPath; // 没带来新记录，别在原地打转
      leaf = newLeaf;
      currentPath = next.path;
    }
    this.warn('claude 分叉链超过跳数上限，后面的分叉未串联', { hops: FORK_MAX_HOPS });
    return currentPath;
  }

  private async findContinuation(
    fromPath: string,
    leaf: string,
    visited: Set<string>
  ): Promise<{ path: string; lines: string[] } | null> {
    const dir = dirname(fromPath);
    const fromInfo = await stat(fromPath).catch(() => null);
    if (!fromInfo) return null;

    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return null;
    }

    // 纯 stat 的粗筛：续写文件一定**更新**（后写的）。❌ 不按「更大」筛 —— 压缩过的会话续写只从压缩点
    // 抄起，通常比源小；挡无关记录靠下面的首条消息预判（只读开头），不靠大小。
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const path = join(dir, name);
      if (visited.has(path)) continue;
      const info = await stat(path).catch(() => null);
      if (!info || !info.isFile()) continue;
      if (info.mtimeMs < fromInfo.mtimeMs) continue;
      candidates.push({ path, mtimeMs: info.mtimeMs });
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
    if (candidates.length > FORK_CANDIDATE_LIMIT) {
      this.warn('claude 分叉候选过多，只查了最早的一批', {
        total: candidates.length,
        limit: FORK_CANDIDATE_LIMIT
      });
      candidates.length = FORK_CANDIDATE_LIMIT;
    }

    for (const candidate of candidates) {
      // 先只读开头：首条消息不在锚里的，不可能是这条链的续写 —— 不整份读它。否则同目录里每一份
      // 「更新、更大」的无关记录都要整份读一遍（真实目录实测：打开一条小会话读 17 份、约 125MB）。
      const head = await readFirstMessageUuid(candidate.path);
      if (!head || !this.anchors.has(head)) continue;
      let text: string;
      try {
        text = await readFile(candidate.path, 'utf8');
      } catch {
        continue;
      }
      // 先做一次子串预判：leaf 不在文本里，连行都不用解析。
      if (!text.includes(leaf)) continue;
      const lines = text.split('\n').filter((line) => line.trim().length > 0);
      if (!lines.some((line) => parseJson(line)?.uuid === leaf)) continue;
      return { path: candidate.path, lines };
    }
    return null;
  }
}

async function readFirstMessageUuid(path: string): Promise<string | null> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of lines) {
      if (seen >= HEAD_SCAN_MAX_LINES) break;
      seen += 1;
      const uuid = parseJson(line)?.uuid;
      if (typeof uuid === 'string' && uuid) return uuid;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/**
 * 找 `<projectRoot>/<项目目录>/<sessionId>.jsonl`。
 *
 * 项目目录名是 cwd 的转义，locator 只给根 —— 与其在这里再造一套转义规则（它随 claude 版本变），
 * 不如把根下的目录列一遍去 stat：一次 readdir + 若干 stat，几十毫秒，而且转义规则怎么变都不会错。
 */
async function resolveSessionFile(locator: SessionRecordLocator): Promise<string> {
  const name = `${locator.providerSessionId}.jsonl`;
  for (const root of locator.roots) {
    if (await isFile(join(root, name))) return join(root, name);
  }
  const hit = await findUnder(locator.roots, '', name);
  if (hit) return hit;
  throw new SessionRecordNotFoundError(
    `找不到 claude 会话记录：sessionId=${locator.providerSessionId}`,
    locator.roots.flatMap((root) => [join(root, name), join(root, '*', name)])
  );
}

// ─── 映射 ────────────────────────────────────────────────────────────────────
// 一行记录是什么意思由 core 的 `readClaudeRecord` 读（导入清单读的是同一份）；这里只解码成领域事件。

export function decodeClaudeRecord(
  line: Record<string, unknown>,
  uuid: string
): RecordEntry[] {
  const record = readClaudeRecord(line);
  if (record.sidechain) return [];
  const at = parseTimestamp(record.timestamp);
  const stamp = at !== undefined ? { at } : {};
  const events = record.items.map((item) => toEvent(item, record.messageId));
  const entries: RecordEntry[] = events.map((event, index) => ({
    // 一条记录出多条 event 时按块序号加后缀：块数由记录本身定死，重读同一份记录得到同一批 key。
    key: events.length === 1 ? `claude:${uuid}` : `claude:${uuid}#${index}`,
    ...stamp,
    event
  }));
  if (record.end) {
    entries.push(
      boundaryEntry(
        `claude:${uuid}`,
        at,
        record.end === 'aborted'
          ? { kind: 'turn_aborted' }
          : record.end === 'error'
            ? { kind: 'turn_failed' }
            : { kind: 'turn_end', stopReason: record.end }
      )
    );
  }
  return entries;
}

function toEvent(item: ClaudeRecordItem, messageId: string | null): NormalizedEvent {
  switch (item.kind) {
    case 'text':
      return item.text ? { kind: 'message', role: item.role, messageId, text: item.text } : { kind: 'ignored' };
    case 'thinking':
      return item.text ? { kind: 'thinking', messageId, text: item.text } : { kind: 'ignored' };
    case 'tool_use':
      return toolCallStart(item.id, item.name, claudeToolKind(item.name), item.input);
    case 'tool_result': {
      const status = item.isError ? 'failed' : 'completed';
      const text = toolResultText(item.content);
      // The result's pictures go as ACP image blocks, as the live ACP stream has them (148 10-14): the card draws them.
      const images = Array.isArray(item.content) ? item.content.flatMap(toolResultImage) : [];
      // A text projection must not hide the other result blocks from disclosure: any block that is neither text nor a
      // picture keeps the whole result disclosed (#6020).
      const hasOther = Array.isArray(item.content)
        ? item.content.some((block) => !['text', 'image'].includes(String(asRecord(block)?.type)))
        : typeof item.content !== 'string' && item.content !== undefined;
      const displayed = hasOther ? JSON.stringify(item.content, null, 2) : text;
      return toolCallResult(item.toolUseId, status, {
        ...(displayed != null ? { text: displayed } : {}),
        images,
        ...(hasOther ? { rawOutput: item.content } : {}),
      });
    }
  }
}

/** A picture in a tool result, as Claude records it (`{ type: 'image', source: { type: 'base64', media_type, data } }`). */
function toolResultImage(block: unknown): { mimeType: string; data: string }[] {
  const source = asRecord(asRecord(block)?.source);
  if (asRecord(block)?.type !== 'image' || source?.type !== 'base64') return [];
  return typeof source.media_type === 'string' && typeof source.data === 'string' && source.data
    ? [{ mimeType: source.media_type, data: source.data }]
    : [];
}

function toolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * claude 的工具名 → ACP ToolKind。
 *
 * ACP 的 ToolKind 是**封闭枚举**，`Task`（子 agent）、`mcp__*`（MCP 工具）在里面没有对应档位，
 * 只能落 'other' —— reducer 会把它们折成 unknown-tool-call 并保住工具名。宁可落一档"不认识"，
 * 也❌不要为了让 UI 好看去塞一个语义不对的 kind：那会让子 agent 显示成一次文件读取。
 */
const claudeToolKind = toolKindTable({ read: ['Read', 'NotebookRead'], edit: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'], execute: ['Bash', 'BashOutput', 'KillShell'], search: ['Grep', 'Glob'], fetch: ['WebFetch', 'WebSearch'] });
