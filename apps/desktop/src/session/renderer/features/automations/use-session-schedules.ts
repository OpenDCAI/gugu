import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import {
  automationChangedChannel,
  automationRunChangedChannel,
} from '@shared/core/automations/automationEvents';
import { schedulesBySession, type SessionSchedule } from '@shared/core/automations/session-schedule';

// 任务页上「这个任务还会回来」(侧栏行上的时钟、输入框上方的托盘)读的那一份:那台机器上每条会话给自己排的定时。
// 一台机器一份缓存,变化靠那台机器推来的 automation:* 事件(排上、取消、到点、没送到都经过它们),❌ 轮询。

export function sessionSchedulesQueryKey(machine: string | null): readonly unknown[] {
  return ['session-schedules', machine ?? 'local'];
}

/**
 * 一台机器只挂一次事件:侧栏几百行读同一份缓存,各挂一份监听没有意义。按读者计数,最后一个读者走了才摘。
 */
const wired = new Map<string, { readers: number; stop: () => void }>();

function wire(queryClient: QueryClient, machine: string | null): () => void {
  const key = machine ?? 'local';
  const existing = wired.get(key);
  if (existing) {
    existing.readers += 1;
  } else {
    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey: sessionSchedulesQueryKey(machine) });
    };
    const offChanged = onMachineEvent(machine, automationChangedChannel, invalidate);
    const offRun = onMachineEvent(machine, automationRunChangedChannel, invalidate);
    wired.set(key, {
      readers: 1,
      stop: () => {
        offChanged();
        offRun();
      },
    });
  }
  return () => {
    const entry = wired.get(key);
    if (!entry) return;
    entry.readers -= 1;
    if (entry.readers === 0) {
      entry.stop();
      wired.delete(key);
    }
  };
}

const NONE: readonly SessionSchedule[] = [];

/**
 * 一条会话给自己排的、任务页要给人看的那几条(下一个要回来的在前)。`machine` = 这条会话所在的机器(null = 本机)。
 * `enabled: false` 时不问也不挂事件(侧栏里还没挂载的别的机器上的行,读会话目录里那一格)。
 */
export function useSessionSchedules(
  machine: string | null,
  sessionId: string,
  enabled = true
): readonly SessionSchedule[] {
  const queryClient = useQueryClient();
  useEffect(() => (enabled ? wire(queryClient, machine) : undefined), [queryClient, machine, enabled]);
  const query = useQuery({
    queryKey: sessionSchedulesQueryKey(machine),
    queryFn: () => rpcOn(machine).automations.listSessionSchedules(),
    select: schedulesBySession,
    enabled,
    // 变化全靠事件推;别的机器每问一次都是一次跨网往返。
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data?.get(sessionId) ?? NONE;
}
