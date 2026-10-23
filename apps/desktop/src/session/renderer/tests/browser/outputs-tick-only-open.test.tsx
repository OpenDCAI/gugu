import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_OUTPUTS_PANEL,
  type OutputsPanelState,
} from '@renderer/features/sessions/view/outputs-panel-state';

// 会话页顶上那枚「输出 / 来源」按钮:它的进度心跳(每秒 setNow)从前只要有会话就跑 ——
// 面板关着、屏上没有一个跟着时间走的数,每条开着的会话照样每秒重排、重绘一次整页(mac1 空闲 4 秒
// trace:12 次 Paint;2026-10-05 查整体内存时撞到)。判据直接数那个 1 秒的定时器:面板关着一个都不许有,开着才有。

const mocks = vi.hoisted(() => ({ state: null as OutputsPanelState | null }));

vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useWorkspaceViewModel: () => ({
    outputsPanel: { stateOf: () => mocks.state, dispatch: vi.fn() },
    paneLayout: { groups: [] },
  }),
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-resource-manager', () => ({
  findAcpChatStore: () => undefined,
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, rpcOn: () => ({}) }));
vi.mock('@renderer/lib/machine-routing', () => ({ machineRegistry: { machineOf: () => null } }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ data: [], isError: false }) }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/lib/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: () => null,
  PopoverContent: () => null,
}));
vi.mock('@renderer/lib/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: () => null,
  TooltipContent: () => null,
}));

const { SessionOutputsPopover } = await import('@renderer/features/sessions/view/session-outputs-popover');

let container: HTMLDivElement;
let root: Root;
let setIntervalSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
const ticks = () => setIntervalSpy.mock.calls.filter((call) => call[1] === 1000).length;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  setIntervalSpy = vi.spyOn(window, 'setInterval');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setIntervalSpy.mockRestore();
});

async function draw(state: OutputsPanelState) {
  mocks.state = state;
  await act(async () => {
    root.render(<SessionOutputsPopover sessionId="conversation-1" />);
  });
}

describe('the session header Outputs button', () => {
  it('runs no per-second heartbeat while its panel is closed', async () => {
    await draw(INITIAL_OUTPUTS_PANEL);
    expect(ticks()).toBe(0);
  });

  it('runs the heartbeat while its panel is open — that is where the elapsed times move', async () => {
    await draw({ ...INITIAL_OUTPUTS_PANEL, mode: 'manual' });
    expect(ticks()).toBe(1);
  });
});
