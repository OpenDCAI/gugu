import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { log } from '@renderer/utils/logger';
import { browserAgentStateChannel, type BrowserAgentState } from '@shared/events/browserEvents';

/**
 * #7191 会话的 agent 在不在操作哪个浏览器页签(主进程报,见 agent-browser.ts)。
 * 页签据此画「agent 正在操作」的小条(画在盖着网页的那扇浮窗里,见 agent-browser-overlay.tsx)。
 */
const states = observable.map<string, BrowserAgentState>();
/** 每个页签收到过几次状态事件:补问(见 syncAgentBrowserState)的回复回来时,期间到过事件就以事件为准。 */
const eventCount = new Map<string, number>();

function record(browserId: string, state: BrowserAgentState): void {
  if (state === 'idle') states.delete(browserId);
  else states.set(browserId, state);
}

events.on(browserAgentStateChannel, ({ browserId, state }) => {
  eventCount.set(browserId, (eventCount.get(browserId) ?? 0) + 1);
  runInAction(() => record(browserId, state));
});

/**
 * OpenDCAI/gugu#56 事件只在状态变化的那一刻发一次:界面晚挂上来、或那一刻页签不在屏上,就永远不知道页签已经停在 paused
 * (paused 是粘住的,只有「让 agent 继续」能解开)。所以挂上来 / 露出来 / 窗口重新拿到焦点时主动问一次主进程。
 */
export async function syncAgentBrowserState(browserId: string): Promise<void> {
  const before = eventCount.get(browserId) ?? 0;
  try {
    const { state } = await rpc.browser.agentState(browserId);
    if ((eventCount.get(browserId) ?? 0) !== before) return; // 问的途中事件到了:事件更新,别拿旧回复盖掉
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

/**
 * 浮在网页底部中间的一枚小条:agent 在操作时「停止」,人接管后「让 agent 继续」。
 * ❌ 占一行的横条:它一出现网页就变矮,agent 刚截的图和接下来点的坐标就对不上了。
 */
export const AgentBrowserBadge = observer(function AgentBrowserBadge({ browserId }: { browserId: string }) {
  const { translate } = useSessionMessages();
  const state = agentBrowserState(browserId);
  if (state === 'idle') return null;
  const driving = state === 'driving';
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
      <div
        role="status"
        data-testid="agent-browser-badge"
        data-state={state}
        // 指着这一块时浮窗接住点击(按钮能按),移开就让点击穿过去落到网页上。
        data-agent-overlay-interactive=""
        className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background-1 py-1 pl-3 pr-1 text-xs text-foreground shadow-md"
      >
        <span
          aria-hidden
          className={driving ? 'size-2 animate-pulse rounded-full bg-primary' : 'size-2 rounded-full bg-foreground-muted'}
        />
        <span>{translate(driving ? 'browser.agentDriving' : 'browser.agentPaused')}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 rounded-full px-2 text-xs"
          onClick={() => void (driving ? rpc.browser.pauseAgent(browserId) : rpc.browser.resumeAgent(browserId))}
        >
          {translate(driving ? 'browser.agentStop' : 'browser.agentResume')}
        </Button>
      </div>
    </div>
  );
});

/**
 * 页签工具条里的「让 agent 继续」:人接管(paused)之后才出现。画在工具条这块普通界面里,不靠盖在网页上的那扇浮窗 ——
 * 浮窗没开出来时(OpenDCAI/gugu#56),这里是人唯一能解开暂停的地方。
 */
export const AgentBrowserResumeButton = observer(function AgentBrowserResumeButton({ browserId }: { browserId: string }) {
  const { translate } = useSessionMessages();
  if (agentBrowserState(browserId) !== 'paused') return null;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="agent-browser-resume"
      title={translate('browser.agentPaused')}
      className="shrink-0 text-xs"
      onClick={() => void rpc.browser.resumeAgent(browserId)}
    >
      {translate('browser.agentResume')}
    </Button>
  );
});
