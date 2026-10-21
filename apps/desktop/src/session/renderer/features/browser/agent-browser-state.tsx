import { observable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { events, rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { browserAgentStateChannel, type BrowserAgentState } from '@shared/events/browserEvents';

/**
 * #7191 会话的 agent 在不在操作哪个浏览器页签(主进程报,见 agent-browser.ts)。
 * 页签据此画「agent 正在操作」的小条(画在盖着网页的那扇浮窗里,见 agent-browser-overlay.tsx)。
 */
const states = observable.map<string, BrowserAgentState>();

events.on(browserAgentStateChannel, ({ browserId, state }) => {
  runInAction(() => {
    if (state === 'idle') states.delete(browserId);
    else states.set(browserId, state);
  });
});

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
