import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';

const mocks = vi.hoisted(() => ({
  online: true,
}));

vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    device: (id: string) =>
      id === 'd22'
        ? { id, label: 'd22', isOnline: mocks.online, lastSeenAt: '2026-09-24T08:00:00Z', platform: 'linux' }
        : null,
    connectionState: () => (mocks.online ? 'connected' : 'offline'),
  },
}));

// 悬停提示在 jsdom 里不弹层:把它摊平,只看触发器本身是什么元素、提示写了什么。
vi.mock('@renderer/lib/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'tooltip' }, children),
}));

const { RemoteHostBadge, RemoteHostChip } = await import('./remote-host-chip');

describe('侧栏项目行上的机器名(#6264):纯标签,不可点', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.online = true;
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Element', dom.window.Element);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    container = dom.window.document.querySelector('#root') as HTMLDivElement;
    root = createRoot(container);
    setLocalePreference('zh-CN');
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  async function renderInRow(onRowClick: () => void) {
    await act(async () => {
      root.render(
        React.createElement(
          SessionLocalizationProvider,
          null,
          React.createElement('div', { 'data-testid': 'row', onClick: onRowClick }, React.createElement(RemoteHostChip, { deviceId: 'd22' }))
        )
      );
    });
  }

  it('不是按钮、没有菜单、没有手指光标;点它 = 点这一行', async () => {
    const onRowClick = vi.fn();
    await renderInRow(onRowClick);
    const chip = container.querySelector('[data-remote-host-chip="d22"]') as HTMLElement;
    expect(chip.tagName).toBe('SPAN');
    expect(container.querySelector('button')).toBeNull();
    expect(container.querySelector('[role="menu"], [aria-haspopup]')).toBeNull();
    expect(chip.className).not.toContain('cursor-pointer');
    await act(async () => chip.click());
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('留着状态点与悬停说明(离线时带上次在线)', async () => {
    mocks.online = false;
    await renderInRow(() => {});
    const chip = container.querySelector('[data-remote-host-chip="d22"]') as HTMLElement;
    expect(chip.getAttribute('data-connection-state')).toBe('offline');
    expect(chip.textContent).toBe('d22');
    const tip = container.querySelector('[data-testid="tooltip"]')?.textContent ?? '';
    expect(tip).toContain('d22');
    expect(tip).toContain('离线');
  });

  it('任务区那一行的机器标记:只一枚图标不占行宽,悬停说在哪台机器上、此刻连没连着、属于哪个项目', async () => {
    await act(async () => {
      root.render(
        React.createElement(SessionLocalizationProvider, null, React.createElement(RemoteHostBadge, { deviceId: 'd22', project: 'Beta' }))
      );
    });
    const badge = container.querySelector('[data-remote-host-badge="d22"]') as HTMLElement;
    expect(badge.getAttribute('data-connection-state')).toBe('connected');
    expect(badge.textContent).toBe('');
    expect(container.querySelector('button')).toBeNull();
    const tip = container.querySelector('[data-testid="tooltip"]')?.textContent ?? '';
    expect(tip).toContain('d22');
    // 有了机器标记就不再另画项目标记:它属于哪个项目写进同一句悬停里。
    expect(tip).toContain('属于项目 Beta');
  });
});
