import { createReadStream } from 'node:fs';
import type { ReaderState, TokenEntry, TokenLogReader } from './token-readers/types';

/**
 * 一份日志文件解析到哪儿了 —— 也是 `usage_token_file_cache.data` 里存的东西。
 *
 * `offset` 是**最后一个完整行**之后的字节位置:文件还在被写(会话正在跑)时,末尾那半行不算,
 * 下次从这里接着读。`state` 是读取器逐行推进带着的状态(codex 的上一条累计值与当前模型),
 * 接着读时原样带回去,续读与一口气读完得到同一组条目。
 */
export type ParsedLogFile = {
  v: 1;
  offset: number;
  state: ReaderState;
  entries: TokenEntry[];
};

type PackedEntry = [key: string, ts: number, model: number, input: number, output: number, cacheRead: number, cacheWrite: number];

type PackedLogFile = { v: 1; offset: number; state: ReaderState; models: string[]; entries: PackedEntry[] };

/** 落库用的紧凑形状:模型名只存一遍,条目存成数组。 */
export function packParsedLogFile(parsed: ParsedLogFile): string {
  const models: string[] = [];
  const modelIndex = new Map<string, number>();
  const entries: PackedEntry[] = parsed.entries.map((entry) => {
    let index = modelIndex.get(entry.model);
    if (index === undefined) {
      index = models.length;
      models.push(entry.model);
      modelIndex.set(entry.model, index);
    }
    return [entry.key, entry.ts, index, entry.input, entry.output, entry.cacheRead, entry.cacheWrite];
  });
  const packed: PackedLogFile = { v: 1, offset: parsed.offset, state: parsed.state, models, entries };
  return JSON.stringify(packed);
}

/** 认不出的形状(老版本缓存 / 被截断)返回 null,调用方整份重读。 */
export function unpackParsedLogFile(text: string): ParsedLogFile | null {
  let packed: PackedLogFile;
  try {
    packed = JSON.parse(text) as PackedLogFile;
  } catch {
    return null;
  }
  if (packed?.v !== 1 || typeof packed.offset !== 'number' || !Array.isArray(packed.entries)) return null;
  const models = Array.isArray(packed.models) ? packed.models : [];
  return {
    v: 1,
    offset: packed.offset,
    state: packed.state ?? null,
    entries: packed.entries.map(([key, ts, model, input, output, cacheRead, cacheWrite]) => ({
      key,
      ts,
      model: models[model] ?? 'unknown',
      input,
      output,
      cacheRead,
      cacheWrite,
    })),
  };
}

const NEWLINE = 0x0a;

/**
 * 从 `resume.offset` 起流式读到文件尾(不整份读进内存:单份 claude 会话日志可以上百 MB),
 * 每个完整行先过读取器的字符串预筛,过了才 JSON.parse。解析不了的行跳过(半截写入、别家格式)。
 *
 * 流是按块异步读的,每块之间让出事件循环 —— 主进程不会被一份大文件卡住几秒。
 */
export async function parseLogFile(
  path: string,
  reader: TokenLogReader,
  resume?: ParsedLogFile
): Promise<ParsedLogFile> {
  const start = resume?.offset ?? 0;
  const state: ReaderState = resume ? structuredClone(resume.state) : reader.initialState();
  const entries: TokenEntry[] = resume ? [...resume.entries] : [];
  let consumed = 0;
  // 还没遇到换行的那段(一行可能跨很多块:claude 的单行工具结果能到几十 MB)。按块攒着,
  // 只在**新到的块**里找换行 —— 每块都把整段攒着的重新拼一遍、从头找,单行越长越是平方级。
  let pending: Buffer[] = [];

  const stream = createReadStream(path, { start, highWaterMark: 1 << 20 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const lastNewline = chunk.lastIndexOf(NEWLINE);
    if (lastNewline < 0) {
      pending.push(chunk);
      continue;
    }
    const head = chunk.subarray(0, lastNewline + 1);
    const complete = pending.length > 0 ? Buffer.concat([...pending, head]) : head;
    pending = lastNewline + 1 < chunk.length ? [chunk.subarray(lastNewline + 1)] : [];
    consumed += complete.length;
    for (const line of complete.toString('utf8').split('\n')) {
      if (!line || !reader.mayCarryUsage(line)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const entry = reader.readLine(parsed as Record<string, unknown>, state);
      if (entry) entries.push(entry);
    }
  }
  return { v: 1, offset: start + consumed, state, entries };
}
