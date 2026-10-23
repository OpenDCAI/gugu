import type { NormalizedEvent, NormalizedToolStatus } from '../../acp/reducer/normalized-event';
import type { ToolImage } from '../../acp/models/turns/tool-calls';
import { hasRecordedAnswers, serializePayload, toolOutputText } from '../../acp/models/tool-payload';

export type RecordContentBlock = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

import { RECORD_KEY_BOUNDARY_SUFFIX, type RecordBoundary, type RecordEntry } from '../contract';

/**
 * 各家记录源共用的小件：可见性出口、轮询节拍、JSON 收敛、逐行解析与分批、边界条、工具调用。
 * ❌ 在这里碰 node:* —— 这个文件经 barrel 到得了渲染层;找文件那几件在 `find-file.ts`。
 */

/**
 * 降级出口。
 *
 * 为什么单独开一条而不是往 `onEntries` 里塞：坏行、被跳过的记录、扫描被截断，
 * 这些都不是「记录」，混进 onEntries 就变成了假的会话内容；而全静默跳过又会让
 * 「解析器坏了」和「agent 没说话」长得一模一样 —— 这条通道是让前一种能被看见。
 */
export type RecordSourceWarn = (message: string, detail?: Record<string, unknown>) => void;

export type SessionRecordSourceOptions = {
  /**
   * 轮询间隔（ms）。
   *
   * 轮询是主、fs.watch 是加速：容器 overlayfs / 网络盘上 fs.watch 会**静默**失效
   * （不报错、就是不来事件），而"记录不再更新"与"agent 没说话"在界面上无从区分。
   * 所以最坏情况下的可见延迟由这个值兜底，不由 watch 决定。
   */
  pollIntervalMs?: number;
  warn?: RecordSourceWarn;
};

export const DEFAULT_POLL_INTERVAL_MS = 500;

export function pollInterval(options: SessionRecordSourceOptions | undefined): number {
  const value = options?.pollIntervalMs;
  return typeof value === 'number' && value > 0 ? value : DEFAULT_POLL_INTERVAL_MS;
}

export function warnOf(options: SessionRecordSourceOptions | undefined): RecordSourceWarn {
  return options?.warn ?? (() => {});
}

/**
 * 把 provider 的任意载荷收敛成 JSON 可序列化的值。
 *
 * 时间线会经 Realtime 广播到手机：一个循环引用或一个 undefined
 * 不是「显示得难看一点」，是那一帧整个发不出去。宁可在这里把不认识的东西变成 null。
 */
export function toJsonValue(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'object':
      break;
    default:
      return null;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return null;
  }
}

/** provider 的 ISO 时间戳 → epoch ms；拿不到就不填，❌ 别拿 Date.now() 冒充。 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 一段 JSON 文本 → 对象。不是对象(数组、标量、坏 JSON)都回 null。 */
export function parseJson(text: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * 一批 JSONL 行逐行解析成对象交给 `visit`。解析不出对象、或 `visit` 回 false(形状不对)的算坏行，
 * 这一批读完 warn 一次 —— 坏行不进时间线，也不静默:「解析器坏了」和「agent 没说话」要分得开。
 */
export function forEachJsonLine(
  lines: string[],
  name: string,
  warn: RecordSourceWarn,
  visit: (record: Record<string, unknown>) => boolean
): void {
  let bad = 0;
  for (const line of lines) {
    const record = parseJson(line);
    if (!record || !visit(record)) bad += 1;
  }
  if (bad > 0) warn(`${name} 记录里有无法解析的行，已跳过`, { count: bad });
}

/** 一批 onEntries 的大小。整份读一次几千条，一次性抛给上层会把 reducer 的一轮跑成一次长阻塞。 */
const EMIT_CHUNK = 200;

/** 一批 JSONL 行 → 条目，按 `EMIT_CHUNK` 分批交给 `sink`。`decode` 回 null = 坏行。 */
export function emitJsonLines(
  lines: string[],
  name: string,
  warn: RecordSourceWarn,
  sink: (entries: RecordEntry[]) => void,
  decode: (record: Record<string, unknown>) => RecordEntry[] | null
): void {
  let batch: RecordEntry[] = [];
  forEachJsonLine(lines, name, warn, (record) => {
    const entries = decode(record);
    if (!entries) return false;
    for (const entry of entries) {
      batch.push(entry);
      if (batch.length >= EMIT_CHUNK) {
        sink(batch);
        batch = [];
      }
    }
    return true;
  });
  if (batch.length > 0) sink(batch);
}

/** 定位失败一律抛这个：上层要能把「没这份记录」和「解析炸了」分开报给用户。 */
export class SessionRecordNotFoundError extends Error {
  constructor(
    message: string,
    readonly searched: string[]
  ) {
    super(message);
    this.name = 'SessionRecordNotFoundError';
  }
}

/**
 * 一条边界记录。`key` 是这一家给收尾那条记录的身份键(`<家>:<id>`),边界条在它后面挂固定后缀 ——
 * 与内容块的 `#<下标>` 不会撞，重读同一份记录得到同一个键。
 */
export function boundaryEntry(key: string, at: number | undefined, boundary: RecordBoundary): RecordEntry {
  return { key: `${key}${RECORD_KEY_BOUNDARY_SUFFIX}`, ...(at !== undefined ? { at } : {}), boundary };
}

/**
 * 一家的工具名 → ACP ToolKind,按类列名字。表里没有的一律 `other`:❌ 按名字形状猜 —— 猜错一个
 * 就把「执行命令」画成「读文件」,而界面上看不出是猜的。
 */
export function toolKindTable(groups: Record<string, readonly string[]>): (name: string) => string {
  const byName = new Map<string, string>();
  for (const [kind, names] of Object.entries(groups)) {
    for (const name of names) byName.set(name, kind);
  }
  return (name) => byName.get(name) ?? 'other';
}

/** Native text and pictures use the same domain vocabulary as live ingress. */
export function messageEvent(role: 'user' | 'assistant', block: RecordContentBlock, messageId: string | null): NormalizedEvent {
  return block.type === 'text' && block.text
    ? { kind: 'message', role, messageId, text: block.text }
    : { kind: 'ignored' };
}

/** Native tool invocation, with no intermediate protocol object. */
export function toolCallStart(toolCallId: string, name: string, kind: string, input: unknown, title = name): Extract<NormalizedEvent, { kind: 'tool_call' }> {
  const rawInput = serializePayload(toJsonValue(input));
  return {
    kind: 'tool_call', toolCallId, title, toolKind: kind, status: 'in_progress',
    parentToolCallId: null, locations: [],
    ...(rawInput !== undefined ? { rawInput } : {}),
  };
}

/** A native result preserves display content and the unformatted answer's settlement fact. */
export function toolCallResult(toolCallId: string, status: NormalizedToolStatus, result: {
  text?: string; images?: ToolImage[]; rawInput?: unknown; rawOutput?: unknown;
} = {}): Extract<NormalizedEvent, { kind: 'tool_update' }> {
  const outputText = toolOutputText(result.text);
  const images = result.images?.filter((image) => image.data && image.mimeType.startsWith('image/')).map(({ mimeType, data }) => ({ mimeType, data }));
  const rawInput = serializePayload(toJsonValue(result.rawInput));
  const rawOutput = serializePayload(toJsonValue(result.rawOutput));
  return {
    kind: 'tool_update', toolCallId, status,
    ...(outputText !== undefined ? { outputText } : {}),
    ...(images?.length ? { images } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    recordedAnswers: status === 'completed' && hasRecordedAnswers(result.text ?? rawOutput),
  };
}
