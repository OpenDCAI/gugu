// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';
import { PaneStore } from '@renderer/features/tabs/pane-store';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { EXTENSION_HOST_ACTION_METHOD } from '@shared/extensions/host-actions';

const state = vi.hoisted(() => ({ projects: new Map<string, unknown>() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn() } } }));
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: state.projects }) }));
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }));
const { extensionHostActionHandlers } = await import('@renderer/features/extensions/host-action-handlers');
const panes: PaneStore[] = [];
afterEach(() => { panes.splice(0).forEach((pane) => pane.dispose()); state.projects.clear(); });

function setup() {
  const def = createTabProvider({ kind: 'workspace.main', resourceKey: (s: { path: string }) => s.path, initialize: () => ({ dispose() {} }), dispose() {}, TabBarItem: () => null, TabBarItemDragPreview: () => null, TabContent: () => null });
  const conversation = createTabProvider({ ...def, kind: 'conversation', conversation: true });
  const pane = new PaneStore(createTabRegistry([def, conversation]), { viewId: 'navigation-contract' });
  panes.push(pane);
  pane.open('workspace.main', { path: '/' }, { intent: 'newTab' });
  const a = pane.resolvedActiveTabId!;
  pane.open('workspace.main', { path: '/other' }, { intent: 'newTab' });
  const b = pane.resolvedActiveTabId!;
  state.projects.set('project', { mountedProject: { sessionManager: { sessions: new Map([['session', { viewModel: { paneLayout: { groups: [{ paneId: 'p', pane }], windowPanes: new Map() } } }]]) } } });
  const api = (tabId: string) => createGugu({
    appFiles: {}, reportError: vi.fn(async () => undefined),
    navigationGo: (args: { delta: unknown }) => Promise.resolve(extensionHostActionHandlers[EXTENSION_HOST_ACTION_METHOD]!({ origin: { extensionId: 'workspace', sessionId: 'session', tabId }, action: { kind: 'navigateTab', delta: args.delta } } as never)).then((result: unknown) => (result as { opened: { navigated: boolean } }).opened.navigated),
  } as never, { files: async () => ({}) as never }) as unknown as { navigation?: { go(delta: unknown, ...ignored: unknown[]): Promise<boolean> } };
  return { pane, a, b, api };
}

describe('the App can navigate only its own tab history', () => {
  it('returns true only after its own page actually changes', async () => {
    const { pane, api, a, b } = setup();
    pane.navigate(a, 'workspace.main', { path: '/README' });
    await expect(api(a).navigation!.go(-1)).resolves.toBe(true);
    expect(pane.entries.get(a)?.state).toEqual({ path: '/' });
    expect(pane.entries.get(b)?.state).toEqual({ path: '/other' });
    await expect(api(a).navigation!.go(1)).resolves.toBe(true);
    expect(pane.entries.get(a)?.state).toEqual({ path: '/README' });
  });
  it('Back follows only the host-recorded opener, never an App-supplied tab id', async () => {
    const { pane, api, a } = setup();
    const conversation = pane.openWithState('conversation', { path: 'chat' })!;
    pane.entries.get(a)!.openerTabId = conversation;
    pane.setActiveTab(a);
    await expect(api(a).navigation!.go(-1, { tabId: 'untrusted-target' })).resolves.toBe(true);
    expect(pane.resolvedActiveTabId).toBe(conversation);
    expect(pane.entries.get(a)?.state).toEqual({ path: '/' });
    pane.closeTab(conversation);
    await expect(api(a).navigation!.go(-1)).resolves.toBe(false);
  });
  it('returns false when its tab has no history', async () => {
    const { api, a } = setup(); const app = api(a);
    expect(typeof app.navigation?.go).toBe('function');
    await expect(app.navigation!.go(-1)).resolves.toBe(false);
  });
  it('refuses any delta other than exactly -1 or 1', async () => {
    const { api, a } = setup(); const app = api(a);
    expect(typeof app.navigation?.go).toBe('function');
    for (const delta of [0, 2, 'back', null, { tabId: a }]) await expect(app.navigation!.go(delta)).rejects.toMatchObject({ code: 'invalid' });
  });
  it('another tab context cannot navigate the first tab', async () => {
    const { pane, api, a, b } = setup(); pane.navigate(a, 'workspace.main', { path: '/README' });
    const app = api(b); expect(typeof app.navigation?.go).toBe('function');
    await expect(app.navigation!.go(-1, { tabId: a })).resolves.toBe(false);
    expect(pane.entries.get(a)?.state).toEqual({ path: '/README' });
    expect(pane.navigationOf(a)?.index).toBe(1);
  });
});
