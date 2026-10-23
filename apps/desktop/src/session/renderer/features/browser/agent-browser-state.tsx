import { observable, runInAction } from 'mobx';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { browserAgentStateChannel, type BrowserAgentState } from '@shared/events/browserEvents';

/**
 * Main owns tab activity. The native cursor layer uses it to decide whether to draw;
 * run control belongs to the Agent conversation, not the browser.
 */
const states = observable.map<string, BrowserAgentState>();
/** 每个页签收到过几次状态事件:补问(见 syncAgentBrowserState)的回复回来时,期间到过事件就以事件为准。 */
const eventCount = new Map<string, number>();
const queryCount = new Map<string, number>();

function record(browserId: string, state: BrowserAgentState): void {
  if (state === 'idle') states.delete(browserId);
  else states.set(browserId, state);
}

events.on(browserAgentStateChannel, ({ browserId, state }) => {
  eventCount.set(browserId, (eventCount.get(browserId) ?? 0) + 1);
  runInAction(() => record(browserId, state));
});

/** Query current activity on mount/visibility/focus; events alone can be missed. */
export async function syncAgentBrowserState(browserId: string): Promise<void> {
  const before = eventCount.get(browserId) ?? 0;
  const query = (queryCount.get(browserId) ?? 0) + 1;
  queryCount.set(browserId, query);
  try {
    const { state } = await rpc.browser.agentState(browserId);
    if (queryCount.get(browserId) !== query || (eventCount.get(browserId) ?? 0) !== before) return; // 问的途中事件到了:事件更新,别拿旧回复盖掉
    runInAction(() => record(browserId, state));
  } catch (error) {
    log.warn('[agent-browser-state] could not read the agent state', { browserId, error });
  }
}

/** 页签在屏上时补问当前状态,并在宿主窗口重新拿到焦点时再问一次(人切去别的应用再回来)。 */
export function useAgentBrowserStateSync(browserId: string, active: boolean, hostWindow: Window): void {
  useEffect(() => {
    if (!active) return;
    void syncAgentBrowserState(browserId);
    const onFocus = () => void syncAgentBrowserState(browserId);
    hostWindow.addEventListener('focus', onFocus);
    return () => hostWindow.removeEventListener('focus', onFocus);
  }, [active, browserId, hostWindow]);
}

export function agentBrowserState(browserId: string): BrowserAgentState {
  return states.get(browserId) ?? 'idle';
}
