import type { SessionSummary, StopReason } from '@gugu/session-core/acp';
import type { AgentEvent } from '@shared/core/agents/agentEvents';

const normalStopReasons = new Set<StopReason>([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);

export type AcpAgentStatusAction =
  | { kind: 'event'; event: AgentEvent }
  | { kind: 'reset'; sessionId: string; projectId: string };

/**
 * 此刻 agent 在干活(谁开的工都一样),或收下还没发出去的排队 prompt。
 * 不读 `isGenerating`:它把后台也算进去,而只剩后台是 park,后台单独走 `background` 事件。
 */
function busy(summary: SessionSummary | undefined): boolean {
  if (!summary) return false;
  return agentWorking(summary) || summary.queuedPromptCount > 0;
}

/** agent 在干活;它停下时 machine 的 WorkEnded 把怎么停的写进 lastTurnOutcome / lastStopReason。 */
function agentWorking(summary: SessionSummary): boolean {
  return summary.lifecycle === 'working' || summary.lifecycle === 'cancelling';
}

/** 回合之外还在自己跑的活:后台子代理 + 后台命令。 */
function backgroundWork(summary: SessionSummary | undefined): number {
  return summary ? summary.backgroundAgentCount + summary.backgroundCommandCount : 0;
}

function eventBase(summary: SessionSummary): Omit<AgentEvent, 'type' | 'payload'> {
  return {
    providerId: summary.providerId,
    projectId: summary.projectId,
    sessionId: summary.sessionId,
    timestamp: Date.now(),
  };
}

type StopKind = 'stop' | 'error' | 'reset';

/**
 * The turn a stop or error reports: the group the runtime recorded with the outcome being reported, read from the
 * same summary as that outcome (the machine writes both in one transition). Never reconstructed from neighbouring
 * summaries or from the open group, whose timing the bridge does not control. Starts and waits carry no turn: when
 * work starts the group may not exist yet (it opens with the first content, and an empty cycle never opens one).
 */
function endedTurn(summary: SessionSummary): AgentEvent['payload'] {
  return summary.lastTurnId ? { turnId: summary.lastTurnId } : {};
}

/**
 * agent 刚停下,怎么停的:
 *  - 它在干活:读 WorkEnded 刚写下的结局。
 *  - 只有排队的 prompt 撑着「忙」、还没发出去就没了:没有活跑过,是重置。
 */
function stopKind(previous: SessionSummary, next: SessionSummary): StopKind {
  if (agentWorking(previous)) {
    if (next.lastTurnOutcome === 'errored') return 'error';
    if (next.lastTurnOutcome === 'stopped' && next.lastStopReason === 'cancelled') return 'reset';
    // 宿主发过取消的一轮一律是被打断:有的 harness(MiMo)对取消回 `end_turn`。
    if (previous.lifecycle === 'cancelling' && next.lastTurnOutcome === 'stopped') return 'reset';
    if (
      next.lastTurnOutcome === 'stopped'
      && next.lastStopReason !== null
      && normalStopReasons.has(next.lastStopReason)
    ) {
      return 'stop';
    }
    // machine 的 WorkEnded 必写 stopped / errored;读不到 = 摘要与 machine 对不上。响亮抛给调用方,❌ 猜一个结局。
    throw new Error(
      `ACP agent work of ${next.sessionId} ended without a recorded outcome `
      + `(lastTurnOutcome=${next.lastTurnOutcome}, lastStopReason=${String(next.lastStopReason)})`,
    );
  }
  return 'reset';
}

export function deriveAcpAgentStatusActions(
  previous: SessionSummary | undefined,
  next: SessionSummary | undefined
): AcpAgentStatusAction[] {
  if (!next) {
    if (!previous) return [];
    // An abnormal provider exit is cleaned from the live summary after its terminal error is
    // published. Keep the error projection; a disappearing errored summary is not a normal idle reset.
    if (previous.lastTurnOutcome === 'errored') {
      return [
        {
          kind: 'event',
          event: { ...eventBase(previous), type: 'error', payload: endedTurn(previous) },
        },
      ];
    }
    return [
      {
        kind: 'reset',
        sessionId: previous.sessionId,
        projectId: previous.projectId,
      },
    ];
  }

  if (next.lifecycle === 'lost') {
    // A provider lost mid-turn settles that turn first (WorkEnded, errored), so this error also reports it; a loss
    // while idle ended no turn, and the last recorded ending belongs to earlier work.
    return [
      {
        kind: 'event',
        event: { ...eventBase(next), type: 'error', payload: previous && agentWorking(previous) ? endedTurn(next) : {} },
      },
    ];
  }

  if (next.lifecycle === 'closed') {
    if (next.lastTurnOutcome === 'errored' && previous?.lastTurnOutcome !== 'errored') {
      // ProcessClosed follows TurnEnded(error) and changes lifecycle to closed. That cleanup
      // boundary must not downgrade the already-detected failure to a reset/idle projection.
      return [
        {
          kind: 'event',
          event: { ...eventBase(next), type: 'error', payload: endedTurn(next) },
        },
      ];
    }
    return [
      {
        kind: 'reset',
        sessionId: next.sessionId,
        projectId: next.projectId,
      },
    ];
  }

  const actions: AcpAgentStatusAction[] = [];
  const event = (type: AgentEvent['type'], payload: AgentEvent['payload'] = {}): void => {
    actions.push({ kind: 'event', event: { ...eventBase(next), type, payload } });
  };

  const wasBusy = busy(previous);
  const nowBusy = busy(next);
  // 开工在前:同一次变化里出现的等待要落在这次活上(随它停下而了结),而不是落成会话级的等待。
  const started = !wasBusy && nowBusy;
  if (started) event('start');

  // 等待按请求 id 求差(可以有几条并行的请求),各自带它在等什么。
  const previousWaits = new Set((previous?.pendingPermissionWaits ?? []).map((wait) => wait.requestId));
  const nextWaits = new Set(next.pendingPermissionWaits.map((wait) => wait.requestId));
  for (const requestId of previousWaits) {
    if (!nextWaits.has(requestId)) event('wait_resolved', { waitId: requestId });
  }

  const end = wasBusy && !nowBusy && previous ? stopKind(previous, next) : null;
  if (end === 'stop') {
    // 结束边带上此刻的后台快照:还有后台在跑就是 park。
    event('stop', { backgroundTasks: backgroundWork(next), ...endedTurn(next) });
  } else if (end === 'error') {
    event('error', endedTurn(next));
  } else if (end === 'reset') {
    actions.push({
      kind: 'reset',
      sessionId: next.sessionId,
      projectId: next.projectId,
    });
  }

  // 后台数只认运行时的快照。不随 stop 一起报时单独报一次:数变了,或 reset 刚把日志里的后台清零
  // (取消只停这一轮,后台命令照跑)。
  const background = backgroundWork(next);
  if (end !== 'stop' && (background !== backgroundWork(previous) || (end === 'reset' && background > 0))) {
    event('background', { backgroundTasks: background });
  }

  // 回合的开与结束会带走日志里的等待;还挂着的请求要重新说一遍,否则权限卡还在、状态却不是 needs_user。
  const reassert = started || end !== null;
  for (const wait of next.pendingPermissionWaits) {
    if (reassert || !previousWaits.has(wait.requestId)) {
      event('wait', { waitKind: wait.waitKind, waitId: wait.requestId });
    }
  }

  return actions;
}
