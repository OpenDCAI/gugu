/**
 * Token 的来源:'gugu' = 走咕咕自营模型(扣积分);'byok' = 用户自己的账号(订阅 / 自己的 key)。
 * 纯模块 —— token 扫描 worker 也用它,❌ 引入库、logger 这类主进程单例。
 */
export type ModelSource = 'gugu' | 'byok';

/** 一条会话的来源时间段:`spans` 是 [起始 epoch 毫秒, 来源],按时间升序;`fallback` 用于第一段之前。 */
export type SourceSpans = { fallback: ModelSource | null; spans: Array<[number, ModelSource]> };

/**
 * 某一时刻这条会话在用哪种来源:落在哪一段就是哪一段的;早于第一段(记录出现之前的历史)用 fallback;
 * 什么都没有 → null(说不清,不归到任何一边)。
 */
export function sourceAt(spans: SourceSpans | undefined, ts: number): ModelSource | null {
  if (!spans) return null;
  let current: ModelSource | null = spans.fallback;
  for (const [since, source] of spans.spans) {
    if (since > ts) break;
    current = source;
  }
  return current;
}
