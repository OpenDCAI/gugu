import { ReplicaState } from '@gugu/session-wire';
import { log } from '@renderer/utils/logger';
import { z } from 'zod';
import { machineRegistry } from '../machine-routing';
import { getAcpRuntimeClient } from './runtime-client';

/**
 * #980 一条会话的 agent 此刻在不在跑 —— **不叫醒它**就能知道(behavior session-page「打开会话不叫醒 agent」)。
 *
 * 读的是运行时的会话表(`sessions.list`),与主进程 `watchRunningSessionState` 同一个判据:表里有它、不是 closed / lost、
 * 也不在收口(closing)= 在跑;starting / replaying = 正在被拉起来(投递、定时、别的设备上发的那句),起完才挂得上。
 * ❌ 直接订这条会话的 `session.*`:没有实例时那是 NOT_FOUND,而建立实例就是把它叫醒。
 *
 * 一台机器共用一份副本:打开过的会话页停着时都在等「宿主把它拉起来」,每页各订一份的话,别的机器上的会话就是每页一条
 * 经咕咕云中转的整表流。
 */
export type RunningPhase = 'stopped' | 'starting' | 'running';

export type RunningSessionWatch = {
  /** 此刻这条会话在运行时里走到哪一步。 */
  phase(): RunningPhase;
  dispose(): void;
};

// 只取判据要的那几格,其余原样留着:别的机器上的运行时可能是另一个版本,摘要多一格少一格都不该让打开失败。
const sessionListSchema = z.record(
  z.string(),
  z.object({ sessionId: z.string(), lifecycle: z.string(), closing: z.boolean().optional() }).passthrough()
);
type SessionList = z.infer<typeof sessionListSchema>;

export function runningPhase(list: SessionList, sessionId: string): RunningPhase {
  const row = list[sessionId] ?? Object.values(list).find((entry) => entry.sessionId === sessionId);
  if (!row || row.closing || row.lifecycle === 'closed' || row.lifecycle === 'lost') return 'stopped';
  return row.lifecycle === 'starting' || row.lifecycle === 'replaying' ? 'starting' : 'running';
}

type Listener = { changed(): void; gone(): void };
type SharedList = { listeners: Set<Listener>; replica: Promise<ReplicaState<SessionList>> };

/** 机器 → 那台的会话表副本(null = 本机,记作 'local')。最后一个订的人放手就拆。 */
const lists = new Map<string, SharedList>();

function openList(key: string, machine: string | null): SharedList {
  const listeners = new Set<Listener>();
  const replica = getAcpRuntimeClient(machine).then(async (client) => {
    const state = new ReplicaState<SessionList>(client.sessions.state(undefined, 'list'), {
      schema: sessionListSchema,
      onChange: () => {
        for (const listener of [...listeners]) listener.changed();
      },
    });
    // 这份表没了(连接判它不会再好):拆掉,下一个来订的人重新订一份;已经在等的各自重订,❌ 就此再也等不到宿主拉起它。
    state.onGone((error) => {
      log.warn('ACP running-session list is gone; watchers subscribe again', { machine, error: String(error) });
      if (lists.get(key) === shared) lists.delete(key);
      void state.dispose();
      for (const listener of [...listeners]) listener.gone();
    });
    await state.ready;
    return state;
  });
  const shared: SharedList = { listeners, replica };
  lists.set(key, shared);
  replica.catch(() => {
    if (lists.get(key) === shared) lists.delete(key);
  });
  return shared;
}

/**
 * 看着一条会话在运行时里的那一格。`onChange` 在会话表每变一次时叫(由调用方读 `phase()` 判);
 * `onGone` = 这份表没了,调用方要接着等就重新订一次。读不到表(运行时连不上)时抛。
 */
export async function watchRunningSession(
  sessionId: string,
  handlers: { onChange(): void; onGone(): void }
): Promise<RunningSessionWatch> {
  const machine = machineRegistry.machineOf(sessionId);
  const key = machine ?? 'local';
  const shared = lists.get(key) ?? openList(key, machine);
  const listener: Listener = { changed: () => handlers.onChange(), gone: () => handlers.onGone() };
  shared.listeners.add(listener);
  let replica: ReplicaState<SessionList>;
  try {
    replica = await shared.replica;
  } catch (error) {
    shared.listeners.delete(listener);
    throw error;
  }
  let disposed = false;
  return {
    phase: () => runningPhase(replica.current(), sessionId),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      shared.listeners.delete(listener);
      if (shared.listeners.size > 0 || lists.get(key) !== shared) return;
      lists.delete(key);
      void replica.dispose();
    },
  };
}
