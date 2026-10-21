import type {
  AgentStatus,
  AgentStatusDetail,
  AgentStatusReading,
  AgentWaitKind,
} from '@gugu/core/shared/agentStatus';

/**
 * spec status-event-log —— 一条会话的 agent 状态 = 对它的规范事件日志的纯 reduce。
 *
 * 各条腿只把原始信号翻成这些带归属的事件(哪个会话、哪个等待),翻不出来就不发;
 * 「在不在干活」是状态,❌ 不是「哪一轮开着」:事件不带轮号(#7087,owner 10-10)。
 * 基础态、附属态与功能布尔都只在这里产出。同样的事件序列永远得到同样的结果,所以真机录下的序列可以原样回放。
 */
export type AgentStatusEvent =
  /** agent 开始干活。 */
  | { kind: 'Started'; sessionId: string }
  /**
   * agent 停下了。两个计数 = 这一刻仍开着的自驱工作(harness 报的快照,取代之前的值);缺席 = 这一家不报,计数不动。
   * `outcome` 缺省 = 正常做完;`cancelled` = 被打断。
   */
  | {
      kind: 'Stopped';
      sessionId: string;
      backgroundTasks?: number;
      scheduledTasks?: number;
      outcome?: 'done' | 'cancelled';
    }
  /**
   * agent 干活时开的等待随这次活一起了结。`scope: 'session'` = 宿主开的会话级等待(provider 门的对话框、
   * 宿主替 agent 要的批准),不随停下消失,由它自己的了结边收;agent 没在干活时开的等待也是会话级。
   */
  | { kind: 'WaitStarted'; sessionId: string; id: string; waitKind: AgentWaitKind; scope?: 'session' }
  /** `id` = `*`:此刻开着的等待都了结了(harness 只说得出「接着跑了」,说不出是哪一个)。 */
  | { kind: 'WaitEnded'; sessionId: string; id: string }
  /** 回合边之外报来的自驱工作快照。 */
  | { kind: 'TasksObserved'; sessionId: string; backgroundTasks: number; scheduledTasks?: number }
  /** 宿主停下了在飞的一切(停止键、ACP 取消 / 关闭、进程退出):不是做完,也不是失败,已有的失败照留。 */
  | { kind: 'Interrupted'; sessionId: string }
  | { kind: 'Error'; sessionId: string; reason: string };

export type AgentWorkOutcome = 'done' | 'cancelled' | 'failed' | 'none';

export interface AgentStatusLogReading extends AgentStatusReading {
  /** 最后一条事件是「agent 正常停下且什么都不剩」的那条边:做完未读与完成提示只跟它走。 */
  finished: boolean;
  /** 归属对不上的事件:不改状态,原样报出来。 */
  anomalies: string[];
}

interface Wait {
  kind: AgentWaitKind;
  /** 开的时候 agent 在干活:随这次活了结。false = 会话级。 */
  withWork: boolean;
}

export interface AgentStatusLogState {
  running: boolean;
  waits: Map<string, Wait>;
  backgroundTasks: number;
  scheduledTasks: number;
  error: string | null;
  lastOutcome: AgentWorkOutcome;
  finished: boolean;
}

export function emptyStatusLogState(): AgentStatusLogState {
  return {
    running: false,
    waits: new Map(),
    backgroundTasks: 0,
    scheduledTasks: 0,
    error: null,
    lastOutcome: 'none',
    finished: false,
  };
}

const WAIT_PRIORITY: readonly AgentWaitKind[] = ['approval', 'question', 'plan', 'dialog'];

/**
 * 由一句写下的读数恢复日志(进程里还没有这条会话的日志,行是上一段写下的)。事件里的细节已经丢了,只恢复
 * 读数说得出的那部分:在干活、后台只知道「至少一个」、等待与失败各记一条。
 */
export function restoreStatusLog(
  status: AgentStatus | null,
  detail: AgentStatusDetail | null,
): AgentStatusLogState {
  const s = emptyStatusLogState();
  switch (status) {
    case 'working':
      if (detail === 'parked') s.backgroundTasks = 1;
      else s.running = true;
      break;
    case 'needs_user': {
      s.running = true;
      const kind = WAIT_PRIORITY.find((k) => k === detail) ?? 'approval';
      s.waits.set('restored', { kind, withWork: true });
      break;
    }
    case 'error':
      s.error = 'restored';
      s.lastOutcome = 'failed';
      break;
    case 'idle':
      if (detail === 'done') s.lastOutcome = 'done';
      break;
  }
  return s;
}

function hasBackground(s: AgentStatusLogState): boolean {
  return s.backgroundTasks > 0 || s.scheduledTasks > 0;
}

function hasOpenWork(s: AgentStatusLogState): boolean {
  return s.running || s.waits.size > 0 || hasBackground(s);
}

function statusOf(s: AgentStatusLogState): AgentStatus {
  if (s.error !== null) return 'error';
  if (s.waits.size > 0) return 'needs_user';
  return s.running || hasBackground(s) ? 'working' : 'idle';
}

function detailOf(s: AgentStatusLogState, status: AgentStatus): AgentStatusDetail | null {
  switch (status) {
    case 'error':
      return null;
    case 'needs_user': {
      const kinds = new Set([...s.waits.values()].map((w) => w.kind));
      return WAIT_PRIORITY.find((k) => kinds.has(k)) ?? 'approval';
    }
    case 'working':
      return s.running ? 'running' : 'parked';
    case 'idle':
      return s.lastOutcome === 'done' ? 'done' : 'plain';
  }
}

function stopWork(s: AgentStatusLogState): void {
  s.running = false;
  for (const [id, w] of s.waits) if (w.withWork) s.waits.delete(id);
}

/** 对一条事件推进一步(原地改 `s`)。对不上的事件调 `anomaly`,状态不动。 */
export function stepStatusLog(s: AgentStatusLogState, e: AgentStatusEvent, anomaly: (what: string) => void): void {
  s.finished = false;
  switch (e.kind) {
    case 'Started':
      if (s.running) return;
      s.running = true;
      s.waits.clear(); // 开工 = 之前停着的门(含会话级对话框)都过去了
      s.error = null;
      return;
    case 'Stopped':
      if (!s.running) return anomaly('Stopped while the agent was not working');
      stopWork(s);
      if (e.backgroundTasks !== undefined) s.backgroundTasks = e.backgroundTasks;
      if (e.scheduledTasks !== undefined) s.scheduledTasks = e.scheduledTasks;
      s.lastOutcome = e.outcome ?? 'done';
      s.finished = s.lastOutcome === 'done' && !hasOpenWork(s) && s.error === null;
      return;
    case 'WaitStarted':
      s.waits.set(e.id, { kind: e.waitKind, withWork: s.running && e.scope !== 'session' });
      return;
    case 'WaitEnded':
      if (e.id === '*') s.waits.clear();
      else if (!s.waits.delete(e.id)) anomaly(`wait ${e.id} ended but not open`);
      return;
    // 后台跑完不是停下的边:会自己醒来的 harness 会再开工,「做完」跟那次停下走。
    case 'TasksObserved':
      s.backgroundTasks = e.backgroundTasks;
      if (e.scheduledTasks !== undefined) s.scheduledTasks = e.scheduledTasks;
      return;
    case 'Interrupted':
      if (hasOpenWork(s)) s.lastOutcome = 'cancelled';
      s.running = false;
      s.waits.clear();
      s.backgroundTasks = 0;
      s.scheduledTasks = 0;
      return;
    case 'Error': // 失败让 agent 停下;错误保持到它下次开工
      stopWork(s);
      s.error = e.reason;
      s.lastOutcome = 'failed';
      return;
  }
}

export function readStatusLog(s: AgentStatusLogState): Omit<AgentStatusLogReading, 'anomalies'> {
  const status = statusOf(s);
  return {
    status,
    detail: detailOf(s, status),
    running: s.running,
    background: s.backgroundTasks > 0 ? 'running' : s.scheduledTasks > 0 ? 'scheduled' : null,
    finished: s.finished,
  };
}

export function reduceAgentStatus(sessionId: string, events: readonly AgentStatusEvent[]): AgentStatusLogReading {
  const s = emptyStatusLogState();
  const anomalies: string[] = [];
  for (const e of events) {
    if (e.sessionId !== sessionId) {
      s.finished = false;
      anomalies.push(`${e.kind} from session ${e.sessionId} in the log of ${sessionId}`);
      continue;
    }
    stepStatusLog(s, e, (what) => anomalies.push(what));
  }
  return { ...readStatusLog(s), anomalies };
}

