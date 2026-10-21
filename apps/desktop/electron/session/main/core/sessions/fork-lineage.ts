import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { nativeHomeRoots } from '@gugu/session-core/agents/plugins/helpers';
import { requireNativeHome } from '@gugu/session-plugins/agents';

const SESSION_FILE_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Reading a multi-hundred-MB transcript for lineage is wasteful; the copied ancestor
 * prefix sits at the head of the file, so a capped scan still ranks parents correctly.
 * Only used to rank several same-root candidates when a new fork appears — never per sweep. */
export const TRANSCRIPT_UUID_SCAN_MAX_LINES = 5000;

/**
 * Claude Code archives transcripts under `<config>/projects/<slug>/<sessionId>.jsonl`,
 * where slug is the session cwd with every non-alphanumeric character replaced by '-'.
 */
export function claudeTranscriptDirFor(
  sessionPath: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  // 写 intent / 认新文件只认 claude **现在**用的那一份配置根 = 候选的第一个。
  const [configDir] = nativeHomeRoots(requireNativeHome('claude'), env, homedir());
  return path.join(configDir, 'projects', sessionPath.replace(/[^a-zA-Z0-9]/g, '-'));
}

export type SessionTranscriptFile = {
  providerSessionId: string;
  filePath: string;
};

export type SessionTranscript = SessionTranscriptFile & {
  mtimeMs: number;
};

/** List `<uuid>.jsonl` session transcript files in a Claude project dir — names only, no
 * stat. A missing dir means no Claude sessions ran in this workspace yet — normal. */
export async function listProviderSessionTranscriptFiles(dir: string): Promise<SessionTranscriptFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: SessionTranscriptFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = SESSION_FILE_RE.exec(entry.name);
    if (!match) continue;
    files.push({ providerSessionId: match[1]!, filePath: path.join(dir, entry.name) });
  }
  return files;
}

/** List `<uuid>.jsonl` session transcripts with their mtimes. */
export async function listSessionTranscripts(dir: string): Promise<SessionTranscript[]> {
  const files = await listProviderSessionTranscriptFiles(dir);
  const transcripts: SessionTranscript[] = [];
  for (const file of files) {
    transcripts.push({ ...file, mtimeMs: (await stat(file.filePath)).mtimeMs });
  }
  return transcripts;
}

/** 首条消息之前只有几行元数据(mode / queue-operation 之类);读到这么多行还没见到消息就当它还没有。 */
const TRANSCRIPT_HEAD_SCAN_MAX_LINES = 50;

export type SessionTranscriptHead = {
  /**
   * 第一条消息的 uuid。fork / 续写把源会话的消息原样抄进新记录(uuid 不变),从源会话开头、或压缩后
   * 从最近的压缩点抄起 ⇒ 它必落在源会话的锚里(见 `TranscriptAnchorIndex`);对不上的记录与在管会话
   * 无关,不必再往下读。
   */
  rootUuid: string;
  /** SDK fork(ACP 会话)直接在记录里写明来源会话;CLI / TUI fork 不写,为 null。 */
  forkedFromProviderSessionId: string | null;
};

/**
 * 只读记录开头到第一条消息为止。一条记录一旦写下第一条消息,这两项就不会再变;还没有消息
 * (刚建、半行)时返回 null,由调用方下一趟再读。
 */
export async function readTranscriptHead(filePath: string): Promise<SessionTranscriptHead | null> {
  // 开头几行都不长,小块读就够;默认 64 KB 一块会把用不上的正文也读进来。
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark: 16 * 1024 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const rawLine of lines) {
      if (seen >= TRANSCRIPT_HEAD_SCAN_MAX_LINES) break;
      seen++;
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: { uuid?: unknown; forkedFrom?: { sessionId?: unknown } };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed.uuid !== 'string' || !parsed.uuid) continue;
      const forkedFrom = parsed.forkedFrom?.sessionId;
      return {
        rootUuid: parsed.uuid,
        forkedFromProviderSessionId: typeof forkedFrom === 'string' && forkedFrom ? forkedFrom : null,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}

/** Collect the message uuids of a transcript (line-delimited JSON, tolerant of a partial
 * trailing line mid-write). */
export async function readTranscriptUuids(
  filePath: string,
  maxLines: number = TRANSCRIPT_UUID_SCAN_MAX_LINES
): Promise<Set<string>> {
  const uuids = new Set<string>();
  // Stream line-by-line and stop at the cap — readFile would materialize the whole
  // transcript in main-process memory, defeating the cap's purpose.
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const rawLine of lines) {
      if (seen >= maxLines) break;
      seen++;
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { uuid?: unknown };
        if (typeof parsed.uuid === 'string' && parsed.uuid) uuids.add(parsed.uuid);
      } catch {
        // partial or foreign line — skip
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return uuids;
}

export type ForkParentCandidate = {
  sessionId: string;
  title: string;
  uuids: Set<string>;
  lastInteractedAt: string | null;
};

/**
 * A forked transcript carries a copy of its ancestors' message uuids; the direct parent
 * shares the largest overlap (it contains every earlier ancestor's prefix plus its own
 * segment). Zero overlap means the transcript is unrelated to every candidate — an
 * ordinary external session, not a fork. Ties (fork-of-fork with no new messages in
 * between) break toward the most recently interacted candidate.
 */
export function pickForkParent(
  childUuids: Set<string>,
  candidates: ForkParentCandidate[]
): ForkParentCandidate | null {
  let best: ForkParentCandidate | null = null;
  let bestOverlap = 0;
  for (const candidate of candidates) {
    let overlap = 0;
    for (const uuid of candidate.uuids) {
      if (childUuids.has(uuid)) overlap++;
    }
    if (overlap === 0) continue;
    if (
      best === null ||
      overlap > bestOverlap ||
      (overlap === bestOverlap &&
        (candidate.lastInteractedAt ?? '') > (best.lastInteractedAt ?? ''))
    ) {
      best = candidate;
      bestOverlap = overlap;
    }
  }
  return best;
}

/**
 * 一份记录的「锚」:第一条消息的 uuid,加上每个压缩点(`compact_boundary`)的 uuid。
 *
 * fork / 续写抄的是源会话**从开头**、或者源会话压缩过之后**从最近那个压缩点**起的消息,uuid 原样
 * 保留(claude 2.1.266 实测:压缩后 `--fork-session` 的副本首条就是源会话压缩点那一行)。所以新记录
 * 的首条消息 uuid 必落在源会话的锚里 —— 只比首条,就能把无关的记录挡在门外,不必整份读它们。
 *
 * 压缩点散落在整份记录里,所以锚按字节偏移增量读:第一次读完整份,之后只读追加的部分。
 */
export class TranscriptAnchorIndex {
  private readonly entries = new Map<
    string,
    { offset: number; remainder: Buffer; firstUuid: string | null; anchors: Set<string> }
  >();

  async anchorsOf(filePath: string): Promise<Set<string>> {
    let size: number;
    try {
      size = (await stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw error;
    }
    let entry = this.entries.get(filePath);
    if (!entry || size < entry.offset) {
      entry = { offset: 0, remainder: Buffer.alloc(0), firstUuid: null, anchors: new Set() };
      this.entries.set(filePath, entry);
    }
    if (size === entry.offset) return entry.anchors;

    const current = entry;
    const stream = createReadStream(filePath, { start: current.offset, end: size - 1 });
    try {
      for await (const chunk of stream) {
        const data = Buffer.concat([current.remainder, chunk as Buffer]);
        let lineStart = 0;
        let newline = data.indexOf(0x0a, lineStart);
        while (newline !== -1) {
          this.absorbLine(current, data.subarray(lineStart, newline).toString('utf8'));
          lineStart = newline + 1;
          newline = data.indexOf(0x0a, lineStart);
        }
        current.remainder = Buffer.from(data.subarray(lineStart));
      }
      current.offset = size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return current.anchors;
      throw error;
    } finally {
      stream.destroy();
    }
    return current.anchors;
  }

  private absorbLine(
    entry: { firstUuid: string | null; anchors: Set<string> },
    rawLine: string
  ): void {
    // 首条消息之后只关心压缩点;先做子串预判,绝大多数行不必解析。
    if (entry.firstUuid !== null && !rawLine.includes('compact_boundary')) return;
    let parsed: { uuid?: unknown; subtype?: unknown };
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      return;
    }
    if (typeof parsed.uuid !== 'string' || !parsed.uuid) return;
    if (entry.firstUuid === null) {
      entry.firstUuid = parsed.uuid;
      entry.anchors.add(parsed.uuid);
    }
    if (parsed.subtype === 'compact_boundary') entry.anchors.add(parsed.uuid);
  }
}
