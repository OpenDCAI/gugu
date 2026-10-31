// session-life 的唯一投影(LifeView)在渲染层的镜像 —— 会话所在那台机器的宿主每次转移后经 `sessionLifeViewChannel`
// 报来,第一次读某条会话时先向那台机器要一份当前的。只按 version 取新的,❌ 不在这里推断任何状态。
import { observable, runInAction } from 'mobx';
import type { LifeView } from '@shared/core/sessions/session-life';
import { sessionLifeViewChannel } from '@shared/core/sessions/sessionEvents';
import { onMachineEvent, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';

const views = observable.map<string, LifeView>();
const requested = new Set<string>();
const listening = new Set<string>();

function accept(view: LifeView): void {
  const current = views.get(view.sessionId);
  if (current && current.version >= view.version) return;
  runInAction(() => views.set(view.sessionId, view));
}

function listenOn(machine: string | null): void {
  const key = machine ?? '';
  if (listening.has(key)) return;
  listening.add(key);
  onMachineEvent(machine, sessionLifeViewChannel, accept);
}

/** The session's lifecycle projection, or null until its host has answered the first read. */
export function sessionLifeView(sessionId: string): LifeView | null {
  const machine = machineRegistry.machineOf(sessionId);
  listenOn(machine);
  if (!requested.has(sessionId)) {
    requested.add(sessionId);
    void rpcOn(machine).sessions.lifeView(sessionId).then(accept, (error: unknown) => {
      requested.delete(sessionId);
      throw error;
    });
  }
  return views.get(sessionId) ?? null;
}

/** The person stopped this session (also mid-start): its host's session-life tears it down and holds it. */
export function stopSessionLife(sessionId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeStop(sessionId);
}

/** The person opened or retried this session: its host's session-life starts it (a page never starts a runtime). */
export function startSessionLife(sessionId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(sessionId)).sessions.lifeStart(sessionId);
}

/** A side chat's page opens its fork entry in the source session's host (idempotent for the same parent and source). */
export function forkSessionLife(fork: { forkId: string; parentId: string; forkFromProviderSessionId: string }): Promise<void> {
  return rpcOn(machineRegistry.machineOf(fork.forkId)).sessions.lifeFork(fork);
}

/** The page closed this side chat: its host's session-life ends the fork entry. */
export function endSessionLife(forkId: string): Promise<void> {
  return rpcOn(machineRegistry.machineOf(forkId)).sessions.lifeEnd(forkId);
}
