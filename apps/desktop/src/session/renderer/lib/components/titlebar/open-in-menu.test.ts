import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_IN_APPS } from '@shared/openInApps';
import { OpenInMenuItems, useOpenInTargets } from './open-in-menu';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  openIn: vi.fn(),
  openInApps: {
    availability: {
      finder: true,
      cursor: true,
      terminal: true,
    },
    loading: false,
  },
  toast: vi.fn(),
  updateOpenIn: vi.fn(),
}));

vi.mock('@tanstack/react-hotkeys', () => ({
  useHotkey: vi.fn(),
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: (key: string) => {
    if (key === 'openIn') {
      return {
        value: { default: 'finder', hidden: [] },
        update: mocks.updateOpenIn,
        isLoading: false,
      };
    }
    return { value: {}, update: vi.fn(), isLoading: false };
  },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({
  getEffectiveHotkey: () => null,
  getHotkeyRegistration: () => '',
}));

vi.mock('@renderer/lib/hooks/useOpenInApps', () => ({
  useOpenInApps: () => ({
    icons: {},
    labels: {
      finder: 'Explorer',
      cursor: 'Cursor',
      terminal: 'Terminal',
    },
    availability: mocks.openInApps.availability,
    menuApps: [OPEN_IN_APPS.finder, OPEN_IN_APPS.cursor, OPEN_IN_APPS.terminal],
    platform: 'win32',
    loading: mocks.openInApps.loading,
  }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      openIn: mocks.openIn,
    },
  },
}));

vi.mock('@renderer/lib/ui/select', async () => {
  const React = await import('react');

  type SelectContextValue = {
    onValueChange?: (value: string) => void;
  };

  const SelectContext = React.createContext<SelectContextValue>({});

  function MockSelectItem({
    children,
    disabled,
    value,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    value: string;
  }) {
    const { onValueChange } = React.useContext(SelectContext);
    return React.createElement(
      'button',
      {
        disabled,
        'data-testid': `open-in-option-${value}`,
        onClick: () => onValueChange?.(value),
      },
      children
    );
  }

  return {
    Select: ({
      children,
      onValueChange,
    }: {
      children: React.ReactNode;
      onValueChange?: (value: string) => void;
    }) =>
      React.createElement(
        SelectContext.Provider,
        { value: { onValueChange } },
        React.createElement('div', {}, children)
      ),
    SelectContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    SelectItem: MockSelectItem,
    SelectTrigger: ({ children }: { children: React.ReactNode }) =>
      React.createElement('button', {}, children),
  };
});

vi.mock('@/components/ui/Menu', async () => {
  const React = await import('react');
  return {
    MenuFold: ({ children }: { children: React.ReactNode }) => children,
    MenuItem: ({ icon, children, disabled, onClick }: { icon?: React.ReactNode; children: React.ReactNode; disabled?: boolean; onClick?: () => void }) =>
      React.createElement('button', { disabled, onClick, 'data-testid': 'open-in-row' }, icon, children),
  };
});

vi.mock('@renderer/lib/ui/shortcut', async () => {
  const React = await import('react');
  return {
    BoundShortcut: () => React.createElement('span', {}),
  };
});

vi.mock('@renderer/lib/ui/tooltip', async () => {
  const React = await import('react');
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    TooltipContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    TooltipProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    TooltipTrigger: ({
      children,
      render,
    }: {
      children?: React.ReactNode;
      render?: React.ReactElement;
    }) => render ?? React.createElement('div', {}, children),
  };
});

// gugu-dev#181 项目页签的右键菜单:菜单打开时还没查完这台机器装了哪些 app,就一行「在 X 中打开」都不画 ——
// ❌ 先铺一排灰的(把能装的全列出来)再缩回装了的那几个。查的是页签(菜单的主人),不是菜单自己。
describe('OpenInMenuItems', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    mocks.openInApps.availability = { finder: true, cursor: true, terminal: true };
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  function Owner() {
    return React.createElement(OpenInMenuItems, { targets: useOpenInTargets('C:/repo') });
  }
  const rows = () => [...container.querySelectorAll('[data-testid="open-in-row"]')].map((row) => row.textContent);

  it('draws no rows while it is still finding out which apps are installed', async () => {
    mocks.openInApps.loading = true;
    await act(async () => { root.render(React.createElement(Owner)); });
    expect(rows()).toEqual([]);
  });

  it('then draws the ones it found', async () => {
    mocks.openInApps.loading = false;
    await act(async () => { root.render(React.createElement(Owner)); });
    expect(rows()).toHaveLength(3);
  });
});
