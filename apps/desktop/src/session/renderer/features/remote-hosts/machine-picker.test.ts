import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLocalePreference } from '@/i18n';
import type { RemoteHostDevice } from '@/session/shared/remote-hosts';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { PageHeader } from '@renderer/lib/components/page-header';
import { DeviceScopeProvider } from './device-scope-picker';
import { DeviceScopeStore, LOCAL_DEVICE_SCOPE } from './device-scope-store';
import { MachinePicker } from './machine-picker';
import type { MachineChoice } from './machine-choice';

const mocks = vi.hoisted(() => ({
  hosts: new Map<string, { device: RemoteHostDevice }>(),
}));

vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    start: () => () => {},
    get hosts() {
      return mocks.hosts;
    },
    rpc: {},
    device: (id: string) => mocks.hosts.get(id)?.device ?? null,
    connectionState: () => 'connected',
    canAddMachine: false,
    openAddMachine: () => {},
  },
}));

// 菜单原语在 jsdom 里不弹层:把它摊平成就地渲染的按钮,判据看的是「菜单里画了什么、点了选谁」。
vi.mock('@renderer/lib/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuSeparator: () => null,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'menu' }, children),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
    ...props
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) =>
    React.createElement(
      'button',
      { type: 'button', role: 'menuitem', ...props, disabled, onClick: disabled ? undefined : onClick },
      children
    ),
  DropdownMenuTrigger: ({ render }: { render?: React.ReactNode }) => render ?? null,
}));

function host(id: string, over: Partial<RemoteHostDevice> = {}): RemoteHostDevice {
  return {
    id,
    label: id,
    isOnline: true,
    platform: 'linux',
    lastSeenAt: null,
    sessionDigest: null,
    directTerminal: false,
    ...over,
  };
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

describe('机器选择器:一个组件、一个位置(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.hosts.clear();
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

  async function render(...children: React.ReactNode[]) {
    await act(async () => {
      root.render(React.createElement(SessionLocalizationProvider, null, ...children));
    });
  }

  const machines: MachineChoice[] = [
    { id: 'local', label: '本机', isLocal: true, isOnline: true, kind: 'computer', platform: 'darwin' },
    { id: 'd22', label: 'd22', isLocal: false, isOnline: true, kind: 'server', platform: 'linux', link: 'ssh' },
    {
      id: 'linux1',
      label: 'Linux 1',
      isLocal: false,
      isOnline: false,
      kind: 'server',
      platform: 'linux',
      lastSeenAt: '2026-09-24T08:00:00Z',
    },
  ];

  it('页标题尺寸的触发器是 ghost:种类图标、(别的机器)在线点、名字、箭头;系统与连法不进触发器', async () => {
    await render(React.createElement(MachinePicker, { machines, selectedId: 'd22', onSelect: () => {} }));
    const trigger = container.querySelector('[data-testid="machine-picker"]') as HTMLButtonElement;
    expect(trigger.getAttribute('data-size')).toBe('title');
    expect(trigger.querySelector('[data-kind="server"]')).not.toBeNull();
    expect(trigger.querySelector('[data-slot="machine-dot"]')?.getAttribute('data-state')).toBe('live');
    expect(trigger.textContent).toBe('d22');
    // 与 app 其余选择器触发器同一套:没有边框、静息没有底色,只有悬停 / 按下 / 开着三档。
    expect(trigger.className).not.toMatch(/\bborder\b|bg-foreground/);
    expect(trigger.className).toContain('hover:bg-row-hover');
  });

  it('锁定(项目页):只显示所选那台、没有菜单、没有箭头,不是一个点了没反应的按钮', async () => {
    const onSelect = vi.fn();
    await render(
      React.createElement(MachinePicker, {
        machines,
        selectedId: 'd22',
        onSelect,
        size: 'compact',
        lockedHint: '项目固定在这台机器上',
      })
    );
    const chip = container.querySelector('[data-testid="machine-picker"]') as HTMLElement;
    expect(chip.getAttribute('data-locked')).toBe('true');
    expect(chip.getAttribute('data-selected-id')).toBe('d22');
    expect(chip.tagName).not.toBe('BUTTON');
    expect(chip.textContent).toBe('d22');
    expect(chip.querySelector('[data-slot="machine-dot"]')?.getAttribute('data-state')).toBe('live');
    // 没有菜单:别的机器、「添加一台机器」都不出现。
    expect(container.querySelector('[data-device-id]')).toBeNull();
    expect(container.querySelector('[data-testid="menu"]')).toBeNull();
    // 只读项的样子:没有悬停 / 按下那几档。
    expect(chip.className).not.toContain('hover:bg-row-hover');
  });

  it('锁定的离线机器照样写「离线」', async () => {
    await render(
      React.createElement(MachinePicker, { machines, selectedId: 'linux1', onSelect: () => {}, lockedHint: 'x' })
    );
    const chip = container.querySelector('[data-testid="machine-picker"]') as HTMLElement;
    expect(chip.querySelector('[data-slot="machine-offline"]')).not.toBeNull();
  });

  it('本机不画在线点', async () => {
    await render(React.createElement(MachinePicker, { machines, selectedId: 'local', onSelect: () => {} }));
    const trigger = container.querySelector('[data-testid="machine-picker"]') as HTMLButtonElement;
    expect(trigger.querySelector('[data-slot="machine-dot"]')).toBeNull();
    expect(trigger.querySelector('[data-kind="computer"]')).not.toBeNull();
  });

  it('选着一台离线的:点是灰的,名字后面一段淡色「离线」', async () => {
    await render(
      React.createElement(MachinePicker, { machines, selectedId: 'linux1', onSelect: () => {}, offlineSelectable: true })
    );
    const trigger = container.querySelector('[data-testid="machine-picker"]') as HTMLButtonElement;
    expect(trigger.querySelector('[data-slot="machine-dot"]')?.getAttribute('data-state')).toBe('offline');
    expect(trigger.querySelector('[data-slot="machine-offline"]')?.textContent).toBe('离线');
  });

  it('菜单:每行图标、(别的机器)点、名字,右边「系统 · 连法」;选中的那行标出来;离线的淡着(能选与否看页面)', async () => {
    const onSelect = vi.fn();
    await render(React.createElement(MachinePicker, { machines, selectedId: 'd22', onSelect, offlineSelectable: true }));
    const row = (id: string) => container.querySelector(`[data-device-id="${id}"]`) as HTMLButtonElement;
    expect(row('d22').getAttribute('data-selected')).toBe('true');
    expect(row('local').getAttribute('data-selected')).toBe('false');
    expect(row('d22').textContent).toContain('Linux · 远程 SSH');
    expect(row('local').textContent).toContain('macOS');
    expect(row('linux1').textContent).toMatch(/离线 · /);
    expect(row('linux1').className).toContain('text-foreground-passive');
    expect(row('d22').className).toContain('bg-row-selected');
    expect(row('local').querySelector('[data-slot="machine-dot"]')).toBeNull();
    expect(row('linux1').disabled).toBe(false);
    await act(async () => row('linux1').click());
    expect(onSelect).toHaveBeenCalledWith('linux1');
  });

  it('新建框不给选离线的(选了也建不了)', async () => {
    const onSelect = vi.fn();
    await render(React.createElement(MachinePicker, { machines, selectedId: 'local', onSelect, size: 'compact' }));
    const offline = container.querySelector('[data-device-id="linux1"]') as HTMLButtonElement;
    expect(offline.disabled).toBe(true);
    expect(container.querySelector('[data-testid="machine-picker"]')?.getAttribute('data-size')).toBe('compact');
  });

  it('模块层挂一份:模块里每一页的标题右边都是同一个选择器、同一份选择,说明写出机器名', async () => {
    mocks.hosts.set('d22', { device: host('d22', { hostKind: 'server', directTerminal: true }) });
    const library = new DeviceScopeStore('gugu.library.device', memoryStorage());
    const automations = new DeviceScopeStore('gugu.automations.device', memoryStorage());
    await render(
      React.createElement(
        DeviceScopeProvider,
        {
          store: library,
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement(PageHeader, {
              title: '提示词',
              description: '管理提示词。',
              remoteDescription: (device: string) => `管理 ${device} 上的提示词。`,
            }),
            React.createElement(PageHeader, {
              title: '智能体',
              description: '管理智能体。',
              remoteDescription: (device: string) => `管理 ${device} 上的智能体。`,
            })
          ),
        }
      ),
      React.createElement(
        DeviceScopeProvider,
        {
          store: automations,
          children: React.createElement(PageHeader, {
            title: '已安排',
            description: '按计划运行。',
            remoteDescription: (device: string) => `按计划在 ${device} 上运行。`,
          }),
        }
      )
    );

    const rows = [...container.querySelectorAll('[data-slot="page-title-row"]')];
    expect(rows).toHaveLength(3);
    for (const titleRow of rows) {
      // 标题后面紧跟着选择器,同一行。
      expect(titleRow.children[0]?.tagName).toBe('H2');
      expect(titleRow.children[1]?.querySelector('[data-testid="machine-picker"][data-size="title"]')).not.toBeNull();
    }
    const selectedOf = (i: number) =>
      rows[i]?.querySelector('[data-testid="machine-picker"]')?.getAttribute('data-selected-id');
    expect([selectedOf(0), selectedOf(1), selectedOf(2)]).toEqual([LOCAL_DEVICE_SCOPE, LOCAL_DEVICE_SCOPE, LOCAL_DEVICE_SCOPE]);
    // 本机时说明照旧。
    expect(container.textContent).toContain('管理提示词。');

    // 在「提示词」页头上切到 d22:整个资源库(两页)都跟着,已安排仍是本机。
    const d22Row = rows[0]?.parentElement?.parentElement?.querySelector('[data-device-id="d22"]') as HTMLButtonElement;
    await act(async () => d22Row.click());
    expect([selectedOf(0), selectedOf(1), selectedOf(2)]).toEqual(['d22', 'd22', LOCAL_DEVICE_SCOPE]);
    expect(container.textContent).toContain('管理 d22 上的提示词。');
    expect(container.textContent).toContain('管理 d22 上的智能体。');
    expect(container.textContent).toContain('按计划运行。');
    expect(container.textContent).not.toContain('按计划在 d22 上运行。');
  });

  it('资源库:模块层一个选择器在左栏列头下,子页标题旁不画,说明照样写出机器名', async () => {
    mocks.hosts.set('d22', { device: host('d22') });
    const library = new DeviceScopeStore('gugu.library.device', memoryStorage());
    const { PageSidebarMenu } = await import('@renderer/lib/components/page-layout');
    const { DeviceScopePicker } = await import('./device-scope-picker');
    await render(
      React.createElement(PageSidebarMenu, {
        title: '资源库',
        header: React.createElement(DeviceScopePicker, { store: library, variant: 'sidebar' }),
        items: [{ id: 'prompts', label: '提示词' }],
        activeId: 'prompts',
        onSelect: () => {},
      }),
      React.createElement(DeviceScopeProvider, {
        store: library,
        inTitle: false,
        children: React.createElement(PageHeader, {
          title: '提示词',
          description: '管理提示词。',
          remoteDescription: (device: string) => `管理 ${device} 上的提示词。`,
        }),
      })
    );
    const pickers = container.querySelectorAll('[data-testid="machine-picker"]');
    expect(pickers).toHaveLength(1);
    expect(pickers[0]?.closest('[data-slot="page-sidebar-header"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="page-title-row"] [data-testid="machine-picker"]')).toBeNull();
    await act(async () => (container.querySelector('[data-device-id="d22"]') as HTMLButtonElement).click());
    expect(pickers[0]?.getAttribute('data-selected-id')).toBe('d22');
    expect(container.textContent).toContain('管理 d22 上的提示词。');
  });

  it('整页按机器:看别的机器时说明换成把机器名写进句子的那一句', async () => {
    mocks.hosts.set('d22', { device: host('d22') });
    const store = new DeviceScopeStore('gugu.settings.device', memoryStorage());
    store.select('d22');
    await render(
      React.createElement(
        DeviceScopeProvider,
        {
          store,
          children: React.createElement(PageHeader, {
            title: '仓库',
            description: '配置项目的存放方式。',
            remoteDescription: (device: string) => `配置项目在 ${device} 上的存放方式。`,
          }),
        }
      )
    );
    expect(container.textContent).toContain('配置项目在 d22 上的存放方式。');
    expect(container.textContent).not.toContain('配置项目的存放方式。');
  });
});

describe('每个按机器的页面都挂在模块层、没有第二个选择器(#6264)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const renderer = resolve(here, '../..');
  const read = (path: string) => readFileSync(resolve(renderer, path), 'utf8');

  it.each([
    ['features/automations/components/AutomationsView.tsx', 'automationsDeviceStore', 1],
  ])('%s 用 DeviceScopeProvider 挂 %s', (file, store, count) => {
    const source = read(file);
    const hits = source.match(new RegExp(`<DeviceScopeProvider store=\\{${store}\\}>`, 'g')) ?? [];
    expect(hits).toHaveLength(count);
  });

  // owner:「资源库改了,你设置页也改啊」—— 资源库:左栏列头下一个选择器,整个资源库跟它走,子页标题旁不再各摆一个。
  it('features/library/library-view.tsx:选择器只在左栏列头,内容区只挂一份不画选择器的 Provider', () => {
    const source = read('features/library/library-view.tsx');
    expect(source.match(/<DeviceScopePicker store=\{libraryDeviceStore\} variant="sidebar" \/>/g) ?? []).toHaveLength(1);
    expect(source.match(/<DeviceScopeProvider store=\{libraryDeviceStore\} inTitle=\{false\}>/g) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/<DeviceScopeProvider store=\{\w+\}>/);
  });

  // 设置合一之后(product spec)这几页画在壳的弹窗里,左栏是壳的:按机器的三页(订阅、会话、仓库)
  // 在页首画同一个选择器,三页共用一份选择;界面、浏览器不画。
  it('features/settings/components/SettingsPage.tsx:一份选择(settingsDeviceStore),只挂在按机器的三页上', () => {
    const source = read('features/settings/components/SettingsPage.tsx');
    expect(source).not.toContain('DeviceScopePicker');
    expect(source.match(/<DeviceScopeProvider store=\{settingsDeviceStore\}>/g) ?? []).toHaveLength(1);
    expect(source.match(/byDevice\(</g) ?? []).toHaveLength(3);
  });

  it('旧的几处样子都删了:左栏列头下、搜索框旁、设置行里不再各摆一个', () => {
    expect(read('features/automations/components/AutomationsHeader.tsx')).not.toContain('DeviceScopePicker');
    expect(read('features/automations/components/AutomationsHeader.tsx')).not.toContain('devicePicker');
    expect(read('features/settings/components/SessionSettingsRows.tsx')).not.toContain('DeviceScopePicker');
    expect(read('features/sessions/composer-context-tray.tsx')).not.toContain('ComposerDevicePicker');
  });

  it.each([
    ['features/library/prompts/prompt-library-view.tsx', 'prompts'],
    ['features/settings/agents-page/AgentsSettingsPage.tsx', 'agents'],
    ['features/library/library-view.tsx', 'integrations'],
    ['features/mcp/components/McpLibraryView.tsx', 'mcp'],
    ['features/automations/components/AutomationsHeader.tsx', 'automations'],
    ['features/settings/components/SettingsPage.tsx', 'repository'],
  ])('%s 看别的机器时的说明把机器名写进句子(%s)', (file, key) => {
    expect(read(file)).toContain(`translate('deviceScope.subtitle.${key}', { device })`);
  });

  it('只有个别行按机器的页(通用)和不按机器的页(界面、浏览器)不另写一句远程说明:按机器的那一行自己标机器名', () => {
    const source = read('features/settings/components/SettingsPage.tsx');
    expect(source).not.toMatch(/DescriptionRemote/);
    expect(read('features/settings/components/SessionSettingsRows.tsx')).toContain('<DeviceSettingsTag />');
  });

  it('资源库只有一个选择器:左栏「资源库」列头下,子页标题旁不画(只把机器名写进说明)', () => {
    const source = read('features/library/library-view.tsx');
    expect(source.match(/<DeviceScopePicker\b/g)).toHaveLength(1);
    expect(source).toContain('header={<DeviceScopePicker store={libraryDeviceStore} variant="sidebar" />}');
    expect(source).toContain('<DeviceScopeProvider store={libraryDeviceStore} inTitle={false}>');
  });

  it('选机器的地方全用同一个组件:会话历史(导入会话已并进它)与新建框也是它', () => {
    expect(read('features/session-history/session-history-view.tsx')).toContain('<MachinePicker');
    // 新建页的机器选择器在 use-new-session-machine.tsx(新建页经它拿选择器)。
    expect(read('features/sessions/new-session-page.tsx')).toContain('useNewSessionMachine(');
    expect(read('features/remote-hosts/use-new-session-machine.tsx')).toMatch(/<MachinePicker\s+size="compact"/);
    expect(read('app/composer-embed-root.tsx')).toMatch(/<MachinePicker\s+size="compact"/);
  });
});
