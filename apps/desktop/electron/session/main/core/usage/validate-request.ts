import { enumerateLocalDays, isLocalDay } from './local-day';

/** 一次最多取多少天(含两端)。用量页最大的档是「近一年」,留出余量。 */
export const MAX_USAGE_RANGE_DAYS = 400;

/** 合法返回 null,否则返回一句说明。 */
export function validateLocalUsageRequest(request: unknown): string | null {
  if (request === null || typeof request !== 'object') return 'request must be { from, to }';
  const { from, to } = request as { from?: unknown; to?: unknown };
  if (!isLocalDay(from)) return `from must be a YYYY-MM-DD day, got ${JSON.stringify(from)}`;
  if (!isLocalDay(to)) return `to must be a YYYY-MM-DD day, got ${JSON.stringify(to)}`;
  if (from > to) return `from (${from}) is after to (${to})`;
  // 字符串比较对 YYYY-MM-DD 等价于日期比较;天数按本地日逐日数,不拿毫秒除(夏令时日不是 24 小时)。
  // 先粗判上限,避免对一个荒唐的范围逐日枚举。
  if (Number(to.slice(0, 4)) - Number(from.slice(0, 4)) > 2) {
    return `range ${from}..${to} exceeds ${MAX_USAGE_RANGE_DAYS} days`;
  }
  const days = enumerateLocalDays(from, to).length;
  if (days > MAX_USAGE_RANGE_DAYS) return `range ${from}..${to} is ${days} days, max ${MAX_USAGE_RANGE_DAYS}`;
  return null;
}
