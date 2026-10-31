import { sessionBootTasks } from '../boot-tasks';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessionRunIntervals, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { sqliteTextToMs } from './local-day';

/**
 * 用量页的「运行时长 / 并行 / 峰值」的底账:把每条会话「在干活」的时间段记进 `session_run_intervals`。
 *
 * 「在干活」= agent_status 为 working 或 needs_user;只剩定时唤醒的 park(`/loop`、cron 在两次之间)不算,它可以一挂几天。
 *
 * ## 输入有两路,缺一路就会漏
 *
 * 1. **`agent:status`**(agent-hook-service 每次写下状态后播的那一条)—— 绝大多数状态变化走这里,
 *    进 working 当场开一段,落回 idle / error 当场收。
 * 2. **对账**(每 60 秒一次,以及用量页取数前一次):拿 `sessions.agent_status` 与开着的区间对一遍。
 *    有几处写状态**不经过**那条事件:
 *    - 新建会话出生即 working(build-session-row 的 initialAgentStatus,与会话行同一笔事务落库);
 *    - restart-session 直接把状态写成 working;
 *    - 别的写者(将来新增的)。
 *    对账发现「库里在干活、却没有开着的区间」就补开一段,起点取这行的 created_at / updated_at 中较晚那个
 *    —— 前两种写法正好把其中一个盖成「写下 working 的那一刻」;但只在它晚于上一次对账时才信它,
 *    否则说明这个时刻跟这次转入 working 无关(比如很久以前建的会话),退回用「现在」。
 *    反过来,「区间开着、库里却已不在干活」(漏了收口的那一下)就在对账时收掉。
 *    ⇒ 旁路写入最多差一个对账周期,而大多数旁路之后紧跟着一条真实的 working 事件(引擎起来、首轮开跑),
 *    事件先到就按事件记。❌ 不去改那几处写入点逐个补播 —— 那是 N 块同形补丁,下一个写者照样漏。
 *
 * 心跳:对账时把仍在干活的区间的 `last_seen_at` 盖成现在。进程被强杀来不及收口的,
 * 下次开机由 {@link closeInterruptedRunIntervals} 按 `last_seen_at` 收(最后一次确认它还在跑的时刻)。
 *
 * 所有入口都是同步的 SQLite 操作(better-sqlite3),彼此不会交错;任何失败只记日志,❌ 不抛回状态管道。
 */

const IN_FLIGHT_STATUSES = ['working', 'needs_user'] as const;

/** 同一次状态写入带出的功能布尔(状态写入者的 'agent:status')。 */
export type RunFacts = { running?: boolean; background?: 'running' | 'scheduled' | null };

export function isInFlightStatus(status: string | null | undefined, facts: RunFacts = {}): boolean {
  if (status !== 'working' && status !== 'needs_user') return false;
  return !(status === 'working' && facts.running === false && facts.background === 'scheduled');
}

export const RUN_INTERVAL_HEARTBEAT_MS = 60_000;

/**
 * 心跳断档的判据:两次确认之间隔了超过 3 个心跳周期,说明这段时间进程没在跑(合盖睡眠、进程被挂起)。
 * 那段时间不算「在干活」—— 否则合盖一夜醒来,整夜都被记成运行时长与并行。
 * 处理:区间在最后一次心跳处收口;醒来仍在干活的,从现在另开一段。
 */
export const RUN_INTERVAL_GAP_MS = RUN_INTERVAL_HEARTBEAT_MS * 3;

/** 收口时刻:心跳没断档就是现在;断档了就退回最后一次确认它还在跑的时刻。 */
export function closeAt(lastSeenAt: number, now: number): number {
  return now - lastSeenAt > RUN_INTERVAL_GAP_MS ? lastSeenAt : now;
}

export class RunIntervalRecorder {
  private lastReconcileAt: number;
  /** 最近一次观测是「只剩定时唤醒的 park」的会话:库里是 working,但对账不能把它当在跑补开区间。 */
  private readonly scheduledOnly = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {
    this.lastReconcileAt = now();
  }

  /** `agent:status` 的订阅者。 */
  observeStatus(sessionId: string, status: string, facts: RunFacts = {}): void {
    try {
      if (status === 'working' && facts.running === false && facts.background === 'scheduled') {
        this.scheduledOnly.add(sessionId);
      } else {
        this.scheduledOnly.delete(sessionId);
      }
      if (isInFlightStatus(status, facts)) this.open(sessionId, this.now());
      else this.close(sessionId, this.now());
    } catch (error) {
      log.warn('usage: failed to record run interval', { sessionId, status, error: String(error) });
    }
  }

  /** 任务归档后不再运行;保留历史用量区间,只结束当前区间。 */
  observeArchived(sessionId: string): void {
    this.scheduledOnly.delete(sessionId);
    try {
      this.close(sessionId, this.now());
    } catch (error) {
      log.warn('usage: failed to close run interval of an archived task', {
        sessionId,
        error: String(error),
      });
    }
  }

  /** 对账 + 心跳。见文件抬头「输入有两路」。 */
  reconcile(now: number = this.now()): void {
    const since = this.lastReconcileAt;
    try {
      db.transaction((tx) => {
        const inFlight = tx
          .select({
            id: sessions.id,
            provider: sessions.provider,
            createdAt: sessions.createdAt,
            updatedAt: sessions.updatedAt,
          })
          .from(sessions)
          .where(inArray(sessions.agentStatus, [...IN_FLIGHT_STATUSES]))
          .all();
        const open = tx
          .select({
            id: sessionRunIntervals.id,
            sessionId: sessionRunIntervals.sessionId,
            provider: sessionRunIntervals.provider,
            lastSeenAt: sessionRunIntervals.lastSeenAt,
          })
          .from(sessionRunIntervals)
          .where(isNull(sessionRunIntervals.endedAt))
          .all();

        const inFlightIds = new Set(inFlight.map((row) => row.id).filter((id) => !this.scheduledOnly.has(id)));
        const openSessionIds = new Set(open.map((row) => row.sessionId));

        const gapped = (row: (typeof open)[number]) => now - row.lastSeenAt > RUN_INTERVAL_GAP_MS;
        const stillRunning = open
          .filter((row) => inFlightIds.has(row.sessionId) && !gapped(row))
          .map((row) => row.id);
        if (stillRunning.length > 0) {
          tx.update(sessionRunIntervals)
            .set({ lastSeenAt: now })
            .where(inArray(sessionRunIntervals.id, stillRunning))
            .run();
        }
        // 该收口的:库里已不在干活的(漏了收口那一下),以及心跳断档的(睡了一觉)。
        // 断档的在最后一次心跳处收;醒来仍在干活的,从现在另开一段。
        for (const row of open) {
          const running = inFlightIds.has(row.sessionId);
          if (running && !gapped(row)) continue;
          const endedAt = closeAt(row.lastSeenAt, now);
          tx.update(sessionRunIntervals)
            .set({ endedAt, lastSeenAt: endedAt })
            .where(eq(sessionRunIntervals.id, row.id))
            .run();
          if (running) {
            tx.insert(sessionRunIntervals)
              .values({ sessionId: row.sessionId, provider: row.provider, startedAt: now, endedAt: null, lastSeenAt: now })
              .run();
          }
        }
        for (const row of inFlight) {
          if (openSessionIds.has(row.id) || !inFlightIds.has(row.id)) continue;
          const startedAt = bypassStartMs(row, since, now);
          tx.insert(sessionRunIntervals)
            .values({
              sessionId: row.id,
              provider: row.provider,
              startedAt,
              endedAt: null,
              lastSeenAt: now,
            })
            .run();
        }
      });
      this.lastReconcileAt = now;
    } catch (error) {
      log.warn('usage: run interval reconcile failed', { error: String(error) });
    }
  }

  private open(sessionId: string, now: number): void {
    const existing = db
      .select({ id: sessionRunIntervals.id, lastSeenAt: sessionRunIntervals.lastSeenAt })
      .from(sessionRunIntervals)
      .where(
        and(eq(sessionRunIntervals.sessionId, sessionId), isNull(sessionRunIntervals.endedAt))
      )
      .limit(1)
      .get();
    if (existing) {
      // 一条在干活的事件本身就是「此刻还活着」的证据:没断档就刷新心跳;断档了(刚醒)先在最后一次心跳处收口,再从现在开新段。
      if (now - existing.lastSeenAt <= RUN_INTERVAL_GAP_MS) {
        db.update(sessionRunIntervals).set({ lastSeenAt: now }).where(eq(sessionRunIntervals.id, existing.id)).run();
        return;
      }
      db.update(sessionRunIntervals)
        .set({ endedAt: existing.lastSeenAt })
        .where(eq(sessionRunIntervals.id, existing.id))
        .run();
    }
    const row = db
      .select({ provider: sessions.provider })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get();
    // 会话行已经不在(状态播到时刚被删)就不记:没有 provider 的一段没法归到任何引擎上。
    if (!row) return;
    db.insert(sessionRunIntervals)
      .values({ sessionId, provider: row.provider, startedAt: now, endedAt: null, lastSeenAt: now })
      .run();
  }

  private close(sessionId: string, now: number): void {
    const open = db
      .select({ id: sessionRunIntervals.id, lastSeenAt: sessionRunIntervals.lastSeenAt })
      .from(sessionRunIntervals)
      .where(
        and(eq(sessionRunIntervals.sessionId, sessionId), isNull(sessionRunIntervals.endedAt))
      )
      .all();
    for (const row of open) {
      // 醒来后第一条 idle 事件:睡着的那段不算进去(见 RUN_INTERVAL_GAP_MS)。
      const endedAt = closeAt(row.lastSeenAt, now);
      db.update(sessionRunIntervals)
        .set({ endedAt, lastSeenAt: endedAt })
        .where(eq(sessionRunIntervals.id, row.id))
        .run();
    }
  }
}

/**
 * 旁路转入 working 的会话,这一段从什么时候算起。见文件抬头:created_at / updated_at 中较晚那个,
 * 只在它落在 (上次对账, 现在] 之内时才信,否则用现在。
 */
export function bypassStartMs(
  row: { createdAt: string | null; updatedAt: string | null },
  lastReconcileAt: number,
  now: number
): number {
  const candidates = [sqliteTextToMs(row.createdAt), sqliteTextToMs(row.updatedAt)].filter(
    (value): value is number => value !== null
  );
  const latest = candidates.length > 0 ? Math.max(...candidates) : null;
  return latest !== null && latest > lastReconcileAt && latest <= now ? latest : now;
}

/**
 * 开机收口:上一个进程留下的开着的区间,按它最后一次心跳收。
 * 必须与 agentStatusWriter.settleAfterRestart 同一道闸(数据目录没被别的活宿主占着时才做)—— 否则会把另一个宿主
 * 正在跑的会话的区间收掉。返回收掉的条数。
 */
export function closeInterruptedRunIntervals(): number {
  // Enumeration belongs to this optional recovery sweep, not database initialisation.
  const rows = sessionBootTasks.runSync('run-interval-inventory', '', () =>
    db.selectDistinct({ sessionId: sessionRunIntervals.sessionId }).from(sessionRunIntervals)
      .where(isNull(sessionRunIntervals.endedAt)).all()) ?? [];
  let closed = 0;
  for (const { sessionId } of rows) {
    closed += sessionBootTasks.runSync('run-interval-recovery', sessionId, () => db.update(sessionRunIntervals)
      .set({ endedAt: sql`${sessionRunIntervals.lastSeenAt}` })
      .where(and(eq(sessionRunIntervals.sessionId, sessionId), isNull(sessionRunIntervals.endedAt))).run().changes) ?? 0;
  }
  return closed;
}

export const runIntervalRecorder = new RunIntervalRecorder();

type StatusSource = {
  on(
    name: 'agent:status',
    handler: (input: { sessionId: string; reading: { status: string } & RunFacts }) => void
  ): unknown;
};
type ArchivalSource = {
  on(name: 'session:archived', handler: (sessionId: string) => void): unknown;
};

let installed = false;

/** 开机时装一次:订状态、订归档、起心跳。重复调用是空操作。 */
export function installRunIntervalRecorder(sources: {
  agentStatus: StatusSource;
  sessionEvents: ArchivalSource;
  recorder?: RunIntervalRecorder;
  heartbeatMs?: number;
}): () => void {
  if (installed) return () => {};
  installed = true;
  const recorder = sources.recorder ?? runIntervalRecorder;
  sources.agentStatus.on('agent:status', ({ sessionId, reading }) =>
    recorder.observeStatus(sessionId, reading.status, { running: reading.running, background: reading.background })
  );
  sources.sessionEvents.on('session:archived', (sessionId) =>
    recorder.observeArchived(sessionId)
  );
  recorder.reconcile();
  const timer = setInterval(() => recorder.reconcile(), sources.heartbeatMs ?? RUN_INTERVAL_HEARTBEAT_MS);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    installed = false;
  };
}
