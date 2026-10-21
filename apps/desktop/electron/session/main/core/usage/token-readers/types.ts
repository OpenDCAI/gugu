/**
 * 各家 CLI 的 token 日志读取器。咕咕自己不记 token —— 引擎把每一次请求的用量写在它自己的会话日志里,
 * 这里按 `sessions.provider_session_id` 找到**属于咕咕会话**的那几份文件,逐行读出用量。
 *
 * 加一家 = 在 `token-readers/` 下加一个文件实现 {@link TokenLogReader},再登记进 `registry.ts`。
 * 没有读取器的引擎 token 记 0(契约允许,用量页照样显示它的会话数与时长)。
 */

/** 一次请求(或一段累计差)的用量。 */
export type TokenEntry = {
  /**
   * 去重键。同一次请求会在日志里出现多遍(claude 一条消息按内容块写多行;分叉/续接会把历史整段复制进新文件),
   * 全局按这个键只算一次。
   */
  key: string;
  /** 请求发生的时刻(epoch 毫秒);归天在汇总时按本地时区做,缓存里不存「天」,换时区也不失真。 */
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** 读取器在一份文件里逐行推进时带着的状态(codex 要记上一条累计值与当前模型;claude 不需要)。 */
export type ReaderState = Record<string, unknown> | null;

export type TokenLogReader = {
  /** 与 `sessions.provider` 相同。 */
  provider: string;
  /**
   * 在这些配置根下,找出属于这些会话的日志文件。返回 sessionId → 文件绝对路径列表。
   * 一次扫描只列一遍目录,❌ 不按会话逐个 glob。
   */
  locate(configRoots: readonly string[], providerSessionIds: ReadonlySet<string>): Promise<Map<string, string[]>>;
  initialState(): ReaderState;
  /** 廉价的字符串预筛:不可能带用量的行直接跳过 JSON.parse(日志大头是对话正文)。 */
  mayCarryUsage(line: string): boolean;
  /** 一行已解析的 JSON → 一条用量(或 null)。可以改写 state。纯函数,不碰磁盘。 */
  readLine(entry: Record<string, unknown>, state: ReaderState): TokenEntry | null;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function timestampMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
