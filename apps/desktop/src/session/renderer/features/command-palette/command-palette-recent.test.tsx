// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session as RendererSession } from '@supabase/supabase-js';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishRendererSession } from '@/lib/sessionPublication';
import type { Session } from '@shared/core/sessions/sessions';
import type { SearchItem } from '@shared/core/search';
import { openSessionInSessionWhenReady } from '@renderer/features/sessions/open-session-in-session';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import type { SessionPageStore } from '@renderer/features/sessions/stores/session-store';
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store';
import { CommandPaletteModal } from './command-palette-modal';

type ProjectManager = ConstructorParameters<typeof SidebarStore>[0];
const fixture = vi.hoisted(() => ({
  projects: null as ProjectManager | null,
  sidebar: null as SidebarStore | null,
  results: [] as SearchItem[],
  opened: vi.fn(),
  markOpened: vi.fn(),
  search: vi.fn(),
}));

// Keep the actual opener, account publication, task registry, Palette, ranking and
// SidebarStore. Only host IPC, ready workspace surfaces and unrelated UI are fixtures.
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn(() => () => {}) },
  onMachineEvent: vi.fn(() => () => {}),
  rpc: {
    search: { commandPalette: fixture.search },
    sessions: { markSessionOpened: fixture.markOpened },
  },
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    get projects() { return fixture.projects; },
    get sidebar() { return fixture.sidebar; },
  },
  get sidebarStore() { return fixture.sidebar; },
}));
vi.mock('@renderer/lib/machine-routing', () => ({
  machineRegistry: { machineOf: () => null },
}));
vi.mock('@renderer/lib/machine-clients', () => ({ onEachMachine: () => () => {} }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: { allListedSessions: () => [], cloudScope: () => null },
}));
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({
  sessionAgentBindings: { bindingFor: () => undefined },
}));
vi.mock('@renderer/lib/pty/pty-session', () => ({
  PtySession: class { destroy() {} },
}));
vi.mock('@renderer/features/sessions/stores/workspace-view-model', () => ({
  WorkspaceViewModel: class {},
}));
vi.mock('@renderer/features/sessions/stores/open-file-in-file-editor', () => ({
  makeFileLinkHandlers: () => ({}),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: {} }) }));
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { activeCommands: [] } }));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: vi.fn() }) }));
vi.mock('@renderer/lib/ui/shortcut', () => ({ Shortcut: () => null }));
vi.mock('@renderer/lib/components/agent-status-indicator', () => ({ AgentStatusIndicator: () => null }));
vi.mock('@renderer/features/global-search/search-session', () => ({ openGlobalSearch: vi.fn() }));
vi.mock('@/lib/guguLinks', () => ({ followLink: vi.fn() }));
vi.mock('./palette-projects-group', () => ({ PaletteProjectsGroup: () => null }));
vi.mock('./palette-chats', () => ({ PaletteChatGroups: () => null }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const PROJECT = 'recent-project';
const OLD = 'old-task-outside-rpc-ten';
const freshIds = Array.from({ length: 10 }, (_, index) => `fresh-${index}`);
const allIds = [...freshIds, OLD];
let host: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
let pages: Map<string, SessionPageStore>;
let generation: number;

function signIn(id: string) {
  // Synthetic identity only: no token, network, real account or profile.
  publishRendererSession('SIGNED_IN', { user: { id } } as RendererSession);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  signIn('recent-account-a');
  fixture.opened.mockClear();
  fixture.markOpened.mockClear();
  fixture.search.mockReset().mockImplementation(async () => fixture.results);
  generation = 0;
  pages = new Map();
  for (const [index, id] of allIds.entries()) {
    const at = id === OLD ? '2020-01-01T00:00:00.000Z' : `2026-11-03T00:00:${String(20 - index).padStart(2, '0')}.000Z`;
    const session = { id, projectId: PROJECT, title: id, runtime: 'acp', providerId: 'codex',
      createdAt: at, lastInteractedAt: at, isPinned: false, agentStatus: null } as Session;
    const manager = sessionRegistry.acquire(id, PROJECT, [session]);
    pages.set(id, {
      id, state: 'provisioned', workspaceId: `workspace-${id}`,
      get data() { return manager.sessions.get(id)!.data; },
      get displayName() { return manager.sessions.get(id)!.data.title; },
      viewModel: { paneLayout: { groups: [{ pane: { tabOrder: ['existing-tab'], entries: new Map([['existing-tab', { tabId: 'existing-tab', kind: 'file', state: {} }]]) } }], open: fixture.opened } },
    } as unknown as SessionPageStore);
  }
  fixture.projects = {
    projects: new Map([[PROJECT, { id: PROJECT, name: 'Tasks', state: 'mounted', createdAt: '2020-01-01T00:00:00.000Z',
      mountedProject: { sessionManager: { sessions: pages, provisionSession: vi.fn(async () => {}) } } }]]),
    mountProject: vi.fn(async () => {}),
  } as unknown as ProjectManager;
  fixture.sidebar = new SidebarStore(fixture.projects);
  fixture.results = freshIds.map(id => ({ kind: 'session', id, projectId: PROJECT, title: id,
    subtitle: '', score: 0, lastInteractedAt: pages.get(id)!.data.lastInteractedAt }));
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  host.remove();
  for (const id of allIds) sessionRegistry.release(id);
  publishRendererSession('SIGNED_OUT', null);
  window.localStorage.clear();
});

const taskRows = () => [...host.querySelectorAll('[cmdk-item][data-value^="task:"]')]
  .map(row => row.getAttribute('data-value')!.slice('task:'.length));

async function emptyPalette() {
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>
      <CommandPaletteModal key={++generation} onClose={() => {}} onSuccess={() => {}} />
    </QueryClientProvider>);
  });
  // Wait for the real query consumer's ten rows, not elapsed wall-clock time.
  await vi.waitFor(() => expect(taskRows()).toHaveLength(10));
}

function openOld(onlyIfNoTabs = false) {
  const dispose = openSessionInSessionWhenReady({ projectId: PROJECT, sessionId: OLD, onlyIfNoTabs });
  dispose();
}

function sharedTimes() {
  return allIds.map(id => {
    const data = sessionRegistry.get(id)!.sessions.get(id)!.data;
    return [id, data.lastInteractedAt, data.createdAt];
  });
}

describe('renderer task opening and empty Recent', () => {
  it('recalls an opened local task outside the RPC ten for its account only', async () => {
    expect(fixture.results.map(row => row.id)).not.toContain(OLD);
    expect(sessionRegistry.get(OLD)?.sessions.has(OLD)).toBe(true);
    await emptyPalette();
    expect(taskRows()).toEqual(freshIds);
    expect(fixture.search).toHaveBeenCalledWith({ query: '' });

    // Restoring an already populated pane must not count as an explicit open.
    openOld(true);
    expect(fixture.opened).not.toHaveBeenCalled();
    await emptyPalette();
    expect(taskRows()).toEqual(freshIds);

    openOld();
    expect(fixture.opened).toHaveBeenCalledWith('acp-chat', { sessionId: OLD }, { from: null, intent: 'newTab' });
    await emptyPalette();
    expect(taskRows()).toEqual([OLD, ...freshIds.slice(0, 9)]);
    expect(fixture.results.map(row => row.id)).toEqual(freshIds);

    signIn('recent-account-b');
    await emptyPalette();
    expect(taskRows()).toEqual(freshIds);
    signIn('recent-account-a');
    await emptyPalette();
    expect(taskRows()).toEqual([OLD, ...freshIds.slice(0, 9)]);
  });

  it('keeps the real sidebar ordering and shared interaction timestamps unchanged', async () => {
    const sidebarIds = () => fixture.sidebar!.placement.entries.get(PROJECT)!.map(row => row.id);
    expect(sidebarIds()).toEqual(allIds);
    const beforeTimes = sharedTimes();
    openOld();
    expect(fixture.opened).toHaveBeenCalledOnce();
    await emptyPalette();
    expect(sidebarIds()).toEqual(allIds);
    expect(sharedTimes()).toEqual(beforeTimes);
    expect(allIds.map(id => pages.get(id)!.data.lastInteractedAt)).toEqual(beforeTimes.map(row => row[1]));
    expect(fixture.markOpened).not.toHaveBeenCalled();
  });
});
