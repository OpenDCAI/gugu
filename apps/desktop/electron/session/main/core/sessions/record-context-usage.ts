import { eq } from 'drizzle-orm';
import type { SessionSummary } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { contextUsageBelongsTo, type SessionContextUsage } from '@shared/core/sessions/session-config';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

export type ContextUsageSummary = Pick<
  SessionSummary,
  'lifecycle' | 'isGenerating' | 'contextTokens' | 'contextSize' | 'contextModelId' | 'modelId'
>;

/**
 * 启动落定之后的生命周期。起动 / 重放那段里模型会**过渡**:`session/load` 先报引擎自己的默认,
 * 再由 `applyInitialModel` 设回记录里那个(mac1 真机实撞:重开一次就把读数作废了)。那段的模型不算数。
 */
const SETTLED = new Set<SessionSummary['lifecycle']>(['ready', 'working', 'cancelling']);

/** 一份读数本身;落库时再盖上它属于哪一条原生会话(`SessionContextUsage.providerSessionId`)。 */
export type ContextReading = Omit<SessionContextUsage, 'providerSessionId'>;

/** `write` = 记下这份读数;`clear` = 记录里那份作废;null = 不动。 */
export type ContextUsageChange = { kind: 'write'; reading: ContextReading } | { kind: 'clear' } | null;

/**
 * #7342 一份会话摘要要不要改记录里的上下文读数 —— 判据只在这里。
 *
 * - **写**:不在生成、读数齐、且读数是在会话**此刻跑的模型**下量的,与记录那份不同才写。
 *   流式中 ❌ 写:摘要每个 token 都在变,一轮落定写一次就够(停下后要的只是最后那份)。
 * - **作废**:会话此刻跑的模型已知、且不是记录那份量它时的模型(热切了 / 重开成了别的模型)——
 *   上限随模型变,旧读数 ❌ 冒充新模型的。
 * - 其余不动:还在起 / 重放(模型在过渡)、模型说不出(引擎不报)都不作废;读数还是旧模型量的不写。
 */
export function contextUsageChange(
  recorded: ContextReading | null,
  summary: ContextUsageSummary
): ContextUsageChange {
  if (!SETTLED.has(summary.lifecycle)) return null;
  const current = summary.modelId ?? null;
  const used = summary.contextTokens;
  const size = summary.contextSize;
  if (
    !summary.isGenerating
    && typeof used === 'number'
    && typeof size === 'number'
    && (summary.contextModelId ?? null) === current
  ) {
    if (recorded?.used === used && recorded.size === size && recorded.modelId === current) return null;
    return { kind: 'write', reading: { used, size, modelId: current } };
  }
  if (recorded && current !== null && recorded.modelId !== current) return { kind: 'clear' };
  return null;
}

/** 记录里此刻属于这条会话的那份读数;没有、不是通用模式会话、或量的是别的原生会话 = null。 */
export function readRecordedContextUsage(sessionId: string): ContextReading | null {
  const row = db
    .select({ config: sessions.config, providerSessionId: sessions.providerSessionId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .get();
  const usage = row?.config?.type === 'acp' ? row.config.contextUsage : undefined;
  return usage && contextUsageBelongsTo(usage, row?.providerSessionId) ? usage : null;
}

/**
 * 把 `contextUsageChange` 的结论落进记录,并经 `session:changed` 告诉各个窗口(别的机器上看着这条会话的也走这条)。
 * 读-改-写在同一个**同步**事务里:`config` 同住着别的事实(同 record-live-session-setting)。
 * 写的那份盖上此刻行上的原生会话 id —— 「重来」、换计费路换掉原生会话之后,旧读数自然不再属于它。
 */
export function applyContextUsageChange(sessionId: string, change: NonNullable<ContextUsageChange>): void {
  const written = db.transaction((tx) => {
    const row = tx
      .select({ projectId: sessions.projectId, config: sessions.config, providerSessionId: sessions.providerSessionId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get();
    // 摘要比删除晚一步到:行已经没了,没有可写的。
    if (!row) return null;
    const config = row.config;
    if (config?.type !== 'acp') {
      log.warn('context usage: session record is not a general-mode (ACP) one; reading not recorded', {
        sessionId,
        configType: config?.type ?? null,
      });
      return null;
    }
    if (change.kind === 'write' && !row.providerSessionId) {
      log.warn('context usage: live session has no provider session id on its record; reading not recorded', { sessionId });
      return null;
    }
    const { contextUsage: _previous, ...rest } = config;
    void _previous;
    const usage = change.kind === 'write'
      ? { ...change.reading, providerSessionId: row.providerSessionId as string }
      : null;
    tx.update(sessions)
      .set({ config: usage ? { ...rest, contextUsage: usage } : rest })
      .where(eq(sessions.id, sessionId))
      .run();
    return { projectId: row.projectId, usage };
  });
  if (!written) return;
  // 作废用 `null`,❌ `undefined`:网页宿主那条传输会把 undefined 的键整个丢掉(见 sessionChangedChannel 抬头)。
  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: written.projectId,
    changes: { contextUsage: written.usage },
  });
}
