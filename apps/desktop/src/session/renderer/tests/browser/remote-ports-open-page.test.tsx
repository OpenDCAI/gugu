import { createRoot, type Root } from 'react-dom/client';
import { act, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 端口列表「在浏览器打开」走 `showPage`(人点的:只切过去、不重载),❌ 自己再开一个浏览器页签 —— 同一个端口点两次
// 不再叠两个(owner 10-06:「侧边栏开的 html 全都叫 index.html,还一开一个」)。端口列表只在用 SSH 装上的远端机器的
// 会话里才有,这一格没在产品上实测,由这条用例钉住接线;`showPage` 遇到同一地址只切不开、不重载,钉在
// workspace-view-model.test.ts 的 showPage 那几条里。

const mocks = vi.hoisted(() => ({ showPage: vi.fn(), open: vi.fn(), clipboard: vi.fn(), toast: vi.fn() }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionView: vi.fn() }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: vi.fn() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { currentViewId: 'home' } } }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));

vi.mock('@renderer/features/sessions/session-view-context', () => ({
  useWorkspaceSurface: () => ({ unreachableLabel: null }),
  useWorkspaceViewModel: () => ({ showPage: mocks.showPage, activePane: { open: mocks.open }, paneLayout: { open: mocks.open } }),
}));
vi.mock('@renderer/lib/machine-routing', async (importOriginal) => {
  const original = await importOriginal<{ machineRegistry: object }>();
  return { ...original, machineRegistry: Object.assign(Object.create(original.machineRegistry), { machineOf: () => 'dev-1' }) };
});
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { device: () => ({ label: 'box' }) } }));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: { remotePorts: { list: async () => ({ success: true, data: { forwards: [{ remotePort: 5173, localPort: 15173, phase: 'ready', holders: ['manual'] }], detected: [] } }) }, app: { clipboardWriteText: mocks.clipboard } },
  rpcOn: () => ({ machine: { listeningPorts: async () => ({ success: true, data: { supported: true, ports: [{ port: 5173, process: 'vite' }] } }) } }),
}));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@renderer/lib/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactElement }) => render,
  TooltipContent: () => null,
}));

const { TabContent: RemotePortsTabContent } = await import('@renderer/features/remote-hosts/workspace/remote-ports-tab-view');

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the ports list (a session on an SSH machine)', () => {
  it('shows the cause when copying a forwarded address rejects', async () => {
    mocks.clipboard.mockRejectedValueOnce(new Error('Clipboard write permission denied'));
    await act(async () => root.render(<RemotePortsTabContent
      host={{ resolvedTabs: [{ kind: 'remote-ports', isActive: true }] } as never}
      ctx={{ viewId: 'view-1', projectId: 'remote:dev-1', sessionId: 'session-1' } as never}
    />));
    const copy = () => container.querySelector<HTMLButtonElement>('button[aria-label="remotePorts.copy"]');
    await vi.waitFor(() => expect(copy()).not.toBeNull());
    await act(async () => copy()!.click());
    expect(mocks.clipboard).toHaveBeenCalledWith('http://localhost:15173/');
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith({ title: 'Clipboard write permission denied', variant: 'destructive' });
  });
  it('opens a port through showPage — a person\'s click: switch to it if open, no reload — never a tab of its own', async () => {
    const TabContent = RemotePortsTabContent;
    const host = { resolvedTabs: [{ tabId: 'ports', kind: 'remote-ports', isActive: true, isPreview: false, resource: {} }] };
    const ctx = { viewId: 'view-1', projectId: 'remote:dev-1', sessionId: 'session-1', workspaceId: 'workspace-1' };
    await act(async () => {
      root.render(<TabContent host={host as never} ctx={ctx as never} />);
    });
    const openButton = () => container.querySelector<HTMLButtonElement>('button[aria-label="remotePorts.open"]');
    await vi.waitFor(() => expect(openButton()).not.toBeNull());

    await act(async () => openButton()!.click());
    await act(async () => openButton()!.click());

    expect(mocks.showPage.mock.calls).toEqual([
      ['http://localhost:5173/', { preview: false, reload: false }],
      ['http://localhost:5173/', { preview: false, reload: false }],
    ]);
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
