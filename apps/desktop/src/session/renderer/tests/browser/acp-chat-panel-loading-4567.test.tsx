import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@renderer/features/tabs/pane-context', () => ({
  PaneContext: React.createContext(null),
  PaneProvider: ({ children }: { children: React.ReactNode }) => children,
  usePaneContext: () => ({
    pane: { resolvedTabs: [] },
  }),
}));

vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => (key === 'chat.loading' ? 'Loading chat' : key) }),
}));

vi.mock('@renderer/features/sessions/acp/use-bound-chat-view', () => ({
  useBoundChatView: () => ({ view: null, onReady: () => {}, onGone: () => {} }),
}));

// #4874: the panel reads the「对话视图」preference through react-query; this
// harness mounts it without a QueryClientProvider, so hand it the default
// layout the same way every other data hook above is stubbed.
vi.mock('@renderer/lib/chat/use-session-chat-layout', () => ({
  useSessionChatLayout: () => ({ preset: 'single', userGutter: 0 }),
}));

vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: { get: () => undefined },
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getProjectManagerStore: () => undefined,
  asMounted: () => undefined,
  getProjectStore: () => undefined,
  getProjectViewStore: () => undefined,
  firstMountedProjectId: () => undefined,
  mountedProjectData: () => undefined,
  projectDisplayName: () => undefined,
  projectViewKind: () => 'unknown',
  unmountedMountErrorMessage: () => undefined,
  getGitRepositoryStore: () => undefined,
  getProjectSettingsStore: () => undefined,
  getPrSyncStore: () => undefined,
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionManagerStore: () => undefined,
  getSessionView: () => undefined,
  getEditorView: () => undefined,
  getDiffView: () => undefined,
  getSessionGitWorktreeStore: () => undefined,
  sessionAgentStatus: () => null,
  pageSessions: () => [],
  sessionViewKind: () => 'unknown',
  asProvisioned: () => undefined,
  getRegisteredSessionData: () => undefined,
  getSessionPageStore: () => undefined,
  getPageSessions: () => [],
  getTerminalsForSession: () => [],
  getWorkspaceForSession: () => undefined,
  getWorkspaceViewModel: () => undefined,
  sessionDisplayName: () => undefined,
  describeSessionFailure: () => undefined,
  sessionErrorMessage: () => undefined,
  projectMountErrorMessage: () => undefined,
}));

vi.mock('@renderer/features/integrations/use-connected-issue-providers', () => ({
  useConnectedIssueProviders: () => ({ data: [] }),
}));

vi.mock('@renderer/features/library/prompts/use-prompt-library', () => ({
  usePromptLibrary: () => ({ value: [] }),
}));

vi.mock('@renderer/lib/stores/use-agents', () => ({
  AGENTS_METADATA_QUERY_KEY: ['agents', 'metadata'],
  useAgents: () => ({ data: [] }),
  useAgent: () => ({ data: undefined }),
  useAgentIcon: () => undefined,
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
  sidebarStore: {},
}));

import { AcpChatPanel } from '@renderer/features/sessions/acp/acp-chat-panel';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

describe('ACP task chat loading state (#4567)', () => {
  it('renders a visible loading surface while the conversation store is attaching', async () => {
    host = document.createElement('div');
    host.className = 'emlight gugu-skin';
    document.body.appendChild(host);
    root = createRoot(host);
    // 「重新登录」那一行拿着 queryClient(登完让模型目录重读);这里给一份空的。
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <AcpChatPanel />
      </QueryClientProvider>
    );

    await until('loading surface is visible', () => page.getByText('Loading chat').query()?.checkVisibility({ opacityProperty: true, visibilityProperty: true }) === true);
    await expect.element(page.getByText('Loading chat')).toBeVisible();
    expect(host.querySelector('[data-session-chat-loading="true"]')?.textContent).toContain('Loading chat');

    const element = host.querySelector<HTMLElement>('[data-session-chat-loading="true"]');
    expect(element).not.toBeNull();
    expect(getComputedStyle(element!).visibility).toBe('visible');
    expect(getComputedStyle(element!).display).not.toBe('none');
    expect(element!.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(element!.getBoundingClientRect().height).toBeGreaterThan(0);
  });
});
