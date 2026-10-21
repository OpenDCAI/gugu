import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { PrSelector } from './pr-selector';
import { setLocalePreference } from '@/i18n';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listPullRequests: vi.fn(),
  syncPullRequests: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    pullRequests: {
      listPullRequests: mocks.listPullRequests,
      syncPullRequests: mocks.syncPullRequests,
    },
  },
}));

vi.mock('@renderer/lib/components/pr-status-icon', async () => {
  const React = await import('react');
  return {
    StatusIcon: () => React.createElement('span', { 'data-testid': 'status-icon' }),
  };
});

vi.mock('@renderer/lib/ui/select', async () => {
  const React = await import('react');
  type SelectContextValue = {
    onValueChange?: (value: string) => void;
  };
  const SelectContext = React.createContext<SelectContextValue>({});
  function MockSelectItem({ children, value }: { children: React.ReactNode; value: string }) {
    const { onValueChange } = React.useContext(SelectContext);
    return React.createElement(
      'button',
      {
        'data-testid': `status-${value}`,
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
      React.createElement('div', {}, children),
  };
});

vi.mock('@renderer/lib/ui/combobox', async () => {
  const React = await import('react');

  type ComboboxContextValue = {
    items?: PullRequest[];
    inputValue?: string;
    onInputValueChange?: (value: string, details: { reason: string }) => void;
  };

  const ComboboxContext = React.createContext<ComboboxContextValue>({});
  function MockComboboxInput({
    placeholder,
    rightAddon,
  }: {
    placeholder?: string;
    rightAddon?: React.ReactNode;
  }) {
    const { inputValue, onInputValueChange } = React.useContext(ComboboxContext);
    return React.createElement(
      'div',
      {},
      React.createElement('button', {
        'data-testid': 'search-input',
        placeholder,
        'data-input-value': inputValue ?? '',
        onClick: () => onInputValueChange?.('eng-1463', { reason: 'input' }),
      }),
      rightAddon
    );
  }

  return {
    Combobox: ({
      children,
      items,
      inputValue,
      onInputValueChange,
    }: {
      children: React.ReactNode;
      items?: PullRequest[];
      inputValue?: string;
      onInputValueChange?: (value: string, details: { reason: string }) => void;
    }) =>
      React.createElement(
        ComboboxContext.Provider,
        { value: { items, inputValue, onInputValueChange } },
        children
      ),
    ComboboxContent: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    ComboboxEmpty: ({ children }: { children: React.ReactNode }) => {
      const { items } = React.useContext(ComboboxContext);
      return items?.length ? null : React.createElement('div', {}, children);
    },
    ComboboxInput: MockComboboxInput,
    ComboboxItem: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', {}, children),
    ComboboxList: ({ children }: { children: React.ReactNode }) => {
      const { items } = React.useContext(ComboboxContext);
      return React.createElement(
        'div',
        {},
        items?.map((item) =>
          typeof children === 'function'
            ? (children as (item: PullRequest) => React.ReactNode)(item)
            : children
        )
      );
    },
    ComboboxTrigger: ({ render }: { render: React.ReactElement }) => render,
    ComboboxValue: ({
      children,
      placeholder,
    }: {
      children?: React.ReactNode;
      placeholder?: React.ReactNode;
    }) => React.createElement('div', {}, children ?? placeholder),
  };
});

const PROJECT_ID = 'project-1';
const REPOSITORY_URL = 'https://github.com/acme/repo';

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: REPOSITORY_URL,
    baseRefName: 'main',
    baseRefOid: 'base-oid',
    headRepositoryUrl: REPOSITORY_URL,
    headRefName: 'feature/search',
    headRefOid: 'head-oid',
    identifier: '#1',
    title: 'Search PR',
    description: null,
    status: 'open',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-05-30T00:00:00.000Z',
    updatedAt: '2026-05-30T00:00:00.000Z',
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

// 被测组件经 useSessionMessages 取文案，所以必须活在 task locale provider 下（产品里也是如此）。
// 语言显式钉住：默认偏好是 `system`，会跟着宿主 navigator 漂，下面的断言就会随机器红绿。
// CustomEvent 也换成 jsdom 的：setLocalePreference 会往 window 上派发它，
// 用 Node 全局那个会被 jsdom 的 EventTarget 拒收。
  function localized(node: React.ReactElement): React.ReactElement {
    return React.createElement(SessionLocalizationProvider, null, node);
  }

describe('PrSelector', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.listPullRequests.mockResolvedValue({ success: true, data: { prs: [makePr()] } });
    mocks.syncPullRequests.mockResolvedValue({ success: true });

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    setLocalePreference('en-US');

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  // #6270:收尾顺序是承重的。React 的 scheduler 在模块加载时就抓住了**真的** setImmediate(那时假时钟
  // 还没装),卸载前已 resolve 的请求触发的 setState 会经它排一段渲染。旧顺序先撤 window 再回真时钟,
  // 那段渲染落在 window 已撤之后 → `ReferenceError: window is not defined`(Unhandled,整片判红),
  // 负载越高越容易撞上。现在:卸载 → 回真时钟 → 在 window 还在时把真 immediate 队列走空 → 再撤环境。
  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
    vi.useRealTimers();
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  async function renderSelector(): Promise<void> {
    await act(async () => {
      root.render(
        localized(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(PrSelector, {
              value: null,
              onValueChange: vi.fn(),
              projectId: PROJECT_ID,
              repositoryUrl: REPOSITORY_URL,
            }),
          ),
        ),
      );
    });
  }

  it('passes debounced input text as the pull request search query', async () => {
    await renderSelector();

    expect(mocks.listPullRequests).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.objectContaining({ searchQuery: undefined })
    );

    const input = container.querySelector('[data-testid="search-input"]');
    expect(input).not.toBeNull();

    await act(async () => {
      input!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(mocks.listPullRequests).toHaveBeenLastCalledWith(
      PROJECT_ID,
      expect.objectContaining({ searchQuery: 'eng-1463' })
    );
  });

  it('clears the active search query immediately when the status filter changes', async () => {
    await renderSelector();

    const input = container.querySelector('[data-testid="search-input"]');
    expect(input).not.toBeNull();

    await act(async () => {
      input!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(mocks.listPullRequests).toHaveBeenLastCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        filters: { status: 'open' },
        searchQuery: 'eng-1463',
      })
    );

    const closedStatus = container.querySelector('[data-testid="status-not-open"]');
    expect(closedStatus).not.toBeNull();

    await act(async () => {
      closedStatus!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.listPullRequests).toHaveBeenLastCalledWith(
      PROJECT_ID,
      expect.objectContaining({
        filters: { status: 'not-open' },
        searchQuery: undefined,
      })
    );
  });

  it.each([
    [
      {
        type: 'github_not_found_or_no_access',
        host: 'github.com',
        message:
          'acme/repo on github.com was not found, or the selected GitHub account does not have access.',
      },
      [],
      'acme/repo on github.com was not found, or the selected GitHub account does not have access.',
      false,
    ],
    [
      { type: 'github_account_disabled', message: 'GitHub API is disabled for this project.' },
      [makePr()],
      'GitHub API is disabled for this project.',
      true,
    ],
  ])('shows background sync errors with or without cached pull requests', async (error, prs, message, hasCachedResults) => {
    mocks.syncPullRequests.mockResolvedValue({ success: false, error });
    mocks.listPullRequests.mockResolvedValue({ success: true, data: { prs } });

    await renderSelector();

    // 后台同步失败 → 列表与错误经 React Query 的通知批(假定时器)落到界面:把排上的定时器全跑完再读,
    // ❌ vi.waitFor(假时钟下它每查一次推进 50 ms,整体却受 1 s 真墙钟限制)。
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).toContain(message);
    if (hasCachedResults) {
      expect(container.textContent).toContain('Sync failed');
      expect(container.textContent).toContain('Search PR');
      expect(container.querySelector('.absolute.right-6.bottom-4.left-6')).not.toBeNull();
      expect(container.querySelector('.border-border-destructive')).not.toBeNull();
    }
    expect(container.textContent).not.toContain('No open pull requests');
  });
});
