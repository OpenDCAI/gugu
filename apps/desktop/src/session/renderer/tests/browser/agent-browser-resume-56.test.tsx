import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';

// OpenDCAI/gugu#56 人接管了 agent 在用的页签后,页签停在 paused 且只有「让 agent 继续」能解开。这个按钮的状态原先只靠
// 「状态变化」事件:事件发的那一刻没在听(界面晚挂上来、页签当时不在屏上),界面就永远当作 idle,人找不到按钮。
// 这里钉住:界面主动补问、补问的旧回复不盖掉更新的事件、按钮画在页签工具条里(不依赖盖在网页上的那扇浮窗)。

const mocks = vi.hoisted(() => ({
  agentState: vi.fn(),
  resumeAgent: vi.fn(),
  pauseAgent: vi.fn(),
  handlers: new Set<(payload: { browserId: string; state: string }) => void>(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (_channel: unknown, handler: (payload: { browserId: string; state: string }) => void) => {
      mocks.handlers.add(handler);
      return () => mocks.handlers.delete(handler);
    },
  },
  rpc: { browser: { agentState: mocks.agentState, resumeAgent: mocks.resumeAgent, pauseAgent: mocks.pauseAgent } },
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { AgentBrowserResumeButton, useAgentBrowserStateSync } = await import('@renderer/features/browser/agent-browser-state');

function Probe({ browserId, active }: { browserId: string; active: boolean }) {
  useAgentBrowserStateSync(browserId, active, window);
  return <AgentBrowserResumeButton browserId={browserId} />;
}

const emit = (browserId: string, state: string) => act(async () => mocks.handlers.forEach((handler) => handler({ browserId, state })));
const resumeButton = () => harness.container.querySelector<HTMLButtonElement>('button[data-testid="agent-browser-resume"]');

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => {
  vi.clearAllMocks();
  harness = createReactHarness();
});
afterEach(() => harness.cleanup());

describe('the toolbar\'s "let the agent continue" control', () => {
  it('shows up for a tab that was already paused before the pane looked (the paused event was missed)', async () => {
    mocks.agentState.mockResolvedValue({ state: 'paused' });
    await harness.render(<Probe browserId="missed-event" active />);
    await vi.waitFor(() => expect(resumeButton()).not.toBeNull());
    expect(mocks.agentState).toHaveBeenCalledWith('missed-event');
    expect(resumeButton()!.textContent).toContain('browser.agentResume');

    await act(async () => resumeButton()!.click());
    expect(mocks.resumeAgent).toHaveBeenCalledWith('missed-event');
  });

  it('renders nothing while the agent is idle or driving', async () => {
    mocks.agentState.mockResolvedValue({ state: 'idle' });
    await harness.render(<Probe browserId="idle-tab" active />);
    await vi.waitFor(() => expect(mocks.agentState).toHaveBeenCalled());
    expect(resumeButton()).toBeNull();
    await emit('idle-tab', 'driving');
    expect(resumeButton()).toBeNull();
    await emit('idle-tab', 'paused');
    expect(resumeButton()).not.toBeNull();
    await emit('idle-tab', 'idle');
    expect(resumeButton()).toBeNull();
  });

  it('does not let a stale reply overwrite a newer event (the person resumed while the question was in flight)', async () => {
    let answer!: (value: { state: string }) => void;
    mocks.agentState.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await harness.render(<Probe browserId="race" active />);
    await vi.waitFor(() => expect(mocks.agentState).toHaveBeenCalled());
    await emit('race', 'idle');
    await act(async () => answer({ state: 'paused' }));
    expect(resumeButton()).toBeNull();
  });

  it('asks again when the window regains focus while the tab is on screen', async () => {
    mocks.agentState.mockResolvedValueOnce({ state: 'idle' });
    await harness.render(<Probe browserId="refocus" active />);
    await vi.waitFor(() => expect(mocks.agentState).toHaveBeenCalledTimes(1));
    expect(resumeButton()).toBeNull();

    mocks.agentState.mockResolvedValue({ state: 'paused' });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    await vi.waitFor(() => expect(resumeButton()).not.toBeNull());
  });

  it('does not ask while the tab is not on screen, and asks as soon as it becomes visible', async () => {
    mocks.agentState.mockResolvedValue({ state: 'paused' });
    await harness.render(<Probe browserId="hidden-then-shown" active={false} />);
    expect(mocks.agentState).not.toHaveBeenCalled();
    expect(resumeButton()).toBeNull();

    await harness.render(<Probe browserId="hidden-then-shown" active />);
    await vi.waitFor(() => expect(resumeButton()).not.toBeNull());
  });
});
