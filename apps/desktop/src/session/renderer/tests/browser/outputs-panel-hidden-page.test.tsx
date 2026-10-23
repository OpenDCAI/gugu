import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import {
  INITIAL_OUTPUTS_PANEL,
  type OutputsPanelState,
} from '@renderer/features/sessions/view/outputs-panel-state';

// 切走的任务页留着、只是藏起来(@@@retained-session-pages)。「输出」面板 portal 到页外,页的
// visibility:hidden 管不到它;它又会因为那条任务起了后台命令 / 子智能体自己弹出来 ⇒ 藏着的任务的面板
// 盖在眼前这页上(#7067)。判据:藏着的页,面板的 open 是 false、也不跑心跳;切回来照旧开着。

const mocks = vi.hoisted(() => ({
  state: null as OutputsPanelState | null,
  open: [] as boolean[],
}));

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
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => {
    mocks.open.push(open);
    return <>{children}</>;
  },
  PopoverTrigger: () => null,
  PopoverContent: () => null,
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
  mocks.open = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setIntervalSpy.mockRestore();
});

async function draw(state: OutputsPanelState, shown: boolean) {
  mocks.state = state;
  await act(async () => {
    root.render(
      <PageShownContext.Provider value={shown}>
        <SessionOutputsPopover sessionId="conversation-1" />
      </PageShownContext.Provider>
    );
  });
}

// 自己弹出来、还有一条在跑:就是截图里那一格。
const autoOpened: OutputsPanelState = {
  mode: 'auto',
  seen: new Set(['bg-1']),
  shown: new Set(['bg-1']),
};

describe('the Outputs panel of a retained session page', () => {
  it('does not open while its page is hidden, even when it opened by itself', async () => {
    await draw(autoOpened, false);
    expect(mocks.open.at(-1)).toBe(false);
    expect(ticks()).toBe(0);
  });

  it('is open again when its page comes back on screen', async () => {
    await draw(autoOpened, false);
    await draw(autoOpened, true);
    expect(mocks.open.at(-1)).toBe(true);
    expect(ticks()).toBe(1);
  });

  it('stays closed on screen when nobody opened it', async () => {
    await draw(INITIAL_OUTPUTS_PANEL, true);
    expect(mocks.open.at(-1)).toBe(false);
  });
});
