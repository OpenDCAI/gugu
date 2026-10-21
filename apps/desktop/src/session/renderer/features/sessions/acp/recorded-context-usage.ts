import { contextUsageBelongsTo } from '@shared/core/sessions/session-config';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * #7342 活会话没有读数时(停下了、还在起、刚重开还没跑完一轮),输入框画会话记录里那份最后读数 ——
 * 前提是它**属于此刻这条会话**:同一条原生会话(重来 / 换计费路后上下文从零开始),
 * 同一个模型(上限随模型变)。对不上就不画,❌ 拿旧读数冒充现在的。
 *
 * `currentModelId`:此刻要比对的模型 —— 活会话自报的那个,或起动这一步要设进去的那个;
 * null = 说不出(用记录里的模型起),这时只认原生会话那一条。
 */
export function recordedContextUsage(
  record: Pick<Session, 'contextUsage' | 'providerSessionId'> | undefined,
  currentModelId: string | null
): { contextUsed: number; contextSize: number; cost: null } | null {
  const usage = record?.contextUsage;
  if (!usage || !contextUsageBelongsTo(usage, record.providerSessionId)) return null;
  if (currentModelId !== null && usage.modelId !== currentModelId) return null;
  // 花费是那个进程里的累计,不跟读数一起落盘:停下后说不出,就不说。
  return { contextUsed: usage.used, contextSize: usage.size, cost: null };
}
