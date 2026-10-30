import { open } from 'node:fs/promises';

import type { NormalizedEvent } from '../../acp/reducer/normalized-event';
import type { RecordEntry, RecordImageRef } from '../contract';

/** 核对用的首尾各取多少个字。 */
const PROBE_CHARS = 32;
/** 一张图读回来的上限。位置来自存档,存档坏了也不许让它申请一块离谱的内存。 */
const MAX_IMAGE_CHARS = 64 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 给一行解出来的工具图记下原文位置(`RecordImageRef`),`lineStart` 是这一行第一个字节在文件里的位置。
 *
 * 图的 base64 在记录里是原样一段(codex 是 `data:<type>;base64,` 后面那段,claude 是 `source.data`):解码只是把它从
 * JSON 里切出来,所以这一行的原文里找得到同一串字。找不到(写记录的那一家转义了 `/` 之类)就记 null,那一张照旧随存档
 * 存原图 —— 只是省不下,不会错。
 */
export function locateImages(entries: RecordEntry[], line: string, lineStart: number, path: string): void {
  let from = 0;
  for (const entry of entries) {
    const event = entry.event;
    if (event?.kind !== 'tool_update' || !event.images?.length) continue;
    (entry as Extract<RecordEntry, { event: NormalizedEvent }>).imageOrigins = event.images.map(({ data }) => {
      if (data.length < PROBE_CHARS * 2) return null; // 小图随存档存着就是了,不值一次读盘
      let at = line.indexOf(data, from);
      if (at < 0) at = line.indexOf(data);
      if (at < 0) return null;
      from = at + data.length;
      return {
        path,
        start: lineStart + Buffer.byteLength(line.slice(0, at), 'utf8'),
        chars: data.length,
        head: data.slice(0, PROBE_CHARS),
        tail: data.slice(-PROBE_CHARS),
      };
    });
  }
}

/**
 * 按位置把一张图从记录里读回来。读不到、长度不对、首尾对不上、读出来的不是 base64,一律回 null:
 * 记录只追加,位置一直有效;对不上只可能是文件被改写过,那时❌ 不许把别的字节当图交出去。
 */
export async function readRecordImage(ref: RecordImageRef): Promise<string | null> {
  if (!ref.path.endsWith('.jsonl') || !Number.isSafeInteger(ref.start) || ref.start < 0
    || !Number.isSafeInteger(ref.chars) || ref.chars <= 0 || ref.chars > MAX_IMAGE_CHARS) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(ref.path, 'r');
    const buffer = Buffer.alloc(ref.chars);
    const { bytesRead } = await handle.read(buffer, 0, ref.chars, ref.start);
    if (bytesRead !== ref.chars) return null;
    const data = buffer.toString('latin1');
    return data.startsWith(ref.head) && data.endsWith(ref.tail) && BASE64.test(data) ? data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
