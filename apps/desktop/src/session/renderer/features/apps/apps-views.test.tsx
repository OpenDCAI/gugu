import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// An App opened from the far-left rail (统筹 10-01): the page it shows is the one its last task's session tab shows —
// the same place, so the same live page moved here, not a second one. What the dock claims is what this reads.
const mocks = vi.hoisted(() => ({
  claims: [] as Record<string, unknown>[],
  params: {} as { appId?: string },
  lastSession: undefined as { projectId: string; sessionId: string } | undefined,
  main: null as { kind: string; enabled: boolean; extensionName: string } | null,
  said: { title: null, badge: null, error: null } as { title: string | null; badge: string | number | null; error: string | null },
  saidFor: [] as [string | null, string][],
  toggle: null as null | (() => void),
}));

vi.mock('@renderer/features/extensions/extension-surface-store', () => ({
  extensionSurfaceStore: {
    said: (sessionId: string | null, tabId: string) => {
      mocks.saidFor.push([sessionId, tabId]);
      return mocks.said;
    },
  },
}));

vi.mock('@renderer/features/extensions/extension-shared-slot', () => ({
  ExtensionSharedSlot: (props: Record<string, unknown>) => {
    mocks.claims.push(props);
    return null;
  },
}));
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { mainTabOf: () => mocks.main },
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useParams: () => ({ params: mocks.params }) }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { viewParamsStore: { get session() { return mocks.lastSession; } } } },
}));
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getSessionPageStore: (projectId: string, sessionId: string) =>
    projectId === 'project-1' && sessionId === 'task-1' ? { workspaceId: 'workspace-1', viewModel: { paneLayout: {} } } : undefined,
}));
vi.mock('@renderer/features/sessions/stores/workspace-registry', () => ({
  workspaceRegistry: { get: () => ({ path: '/repo/task-1' }) },
}));
vi.mock('@renderer/features/sessions/view/session-pane-policy', () => ({ activeChatSessionId: () => 'conversation-1' }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));
// The 「App」 page's own pieces: not what this file judges.
vi.mock('@renderer/features/library/library-view', () => ({ useSelectedLibraryHost: vi.fn() }));
vi.mock('@renderer/features/library/extensions-library-page', () => ({ ExtensionsLibraryPage: () => null }));
vi.mock('@renderer/features/library/library-host', () => ({ LibraryHostProvider: () => null }));
vi.mock('@renderer/features/remote-hosts/device-scope-picker', () => ({ DeviceScopeProvider: () => null }));
vi.mock('@renderer/features/remote-hosts/device-scope-store', () => ({ libraryDeviceStore: {} }));
vi.mock('@renderer/lib/components/page-layout', () => ({ PageContent: () => null, PageLayout: () => null }));
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', () => ({ ShellTitlebar: ({ leftSlot }: { leftSlot?: unknown }) => leftSlot ?? null }));
// The chat panel's own mark (AppErrorMark): this file judges where it is put and that it opens, not how it looks.
vi.mock('@/components/appSlot/AppErrorMark', () => ({
  AppErrorMark: (props: { error: string; onToggle: () => void; testId: string }) => {
    mocks.toggle = props.onToggle;
    return <button type="button" data-testid={props.testId} title={props.error} />;
  },
  AppErrorDetails: (props: { error: string; testId: string }) => <div data-testid={props.testId}>{props.error}</div>,
}));

const { appView, appsView } = await import('./apps-views');
const { WINDOW_CONTROL_BAR_HEIGHT_PX } = await import('@/lib/window-chrome');

describe('an App opened from the far-left rail', () => {
  beforeEach(() => {
    mocks.claims.length = 0;
    mocks.saidFor.length = 0;
    mocks.said = { title: null, badge: null, error: null };
    mocks.params = { appId: 'clock' };
    mocks.main = { kind: 'clock.main', enabled: true, extensionName: 'Clock' };
    mocks.lastSession = { projectId: 'project-1', sessionId: 'task-1' };
  });

  // 真源原则 13: the rail's App sits nowhere — what the person is looking at is `getAppState()`'s. Control (the parent
  // commit cbe5b6fd36): it claimed the last session looked at, and its context said that session (before L11 复核 49,
  // a made-up 'draft').
  it('claims its page in no session, a session looked at or not: no session id, no working copy', () => {
    renderToStaticMarkup(<appView.MainPanel />);
    expect(mocks.claims).toEqual([{ tabKind: 'clock.main', tabId: 'dock' }]);
  });

  // 125 10-06 (R's A/B): an App whose page draws from its top edge sat beneath its own name — 「R dice」 over 「Score 17」.
  // The title bar is a zero-height band over the main area; the page starts under it, as a session's tabs do. Control
  // (the parent commit): the slot filled the main area from its top, no room left.
  it('its page starts under the title band (the App\'s name, the window\'s handle), as a session\'s tabs do', () => {
    const markup = renderToStaticMarkup(<appView.MainPanel />);
    expect(markup).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
    expect(mocks.claims).toEqual([{ tabKind: 'clock.main', tabId: 'dock' }]);
  });

  // 125 10-06 (R's A/B): reportError lit the chat panel's red dot and a session tab, but the App's own page — where a notify
  // or link naming no place opens — showed nothing. The same mark as the chat panel's (AppErrorMark), read from the page's
  // own slot. Control (the parent commit): no mark at all.
  // 125 10-06 04:51: where the chat panel puts it — in the title row beside the name, not a row of its own with a line
  // under it; pressed, the whole of it opens over the page.
  it('a page that reported an error shows the chat panel\'s mark beside its name in the title row; pressed, the whole of it', () => {
    mocks.said = { title: null, badge: null, error: 'Could not save: the disk is full' };
    const title = renderToStaticMarkup(<appView.TitlebarSlot />);
    expect(mocks.saidFor).toContainEqual([null, 'dock']);
    expect(title).toMatch(/Clock<\/span><button[^>]*data-testid="app-page-error"[^>]*title="Could not save: the disk is full"/);
    // The page itself has no row of its own for it, and no text until the mark is pressed.
    expect(renderToStaticMarkup(<appView.MainPanel />)).not.toContain('app-page-error');
    mocks.toggle!();
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain('<div data-testid="app-page-error-details">Could not save: the disk is full</div>');
    mocks.toggle!();
    expect(renderToStaticMarkup(<appView.MainPanel />)).not.toContain('app-page-error-details');
    mocks.said = { title: null, badge: null, error: null };
    expect(renderToStaticMarkup(<appView.TitlebarSlot />)).not.toContain('app-page-error');
  });

  it('switched off, it claims nothing and says where it is switched back on — under the title bar, as the page would sit', () => {
    mocks.main = { kind: 'clock.main', enabled: false, extensionName: 'Clock' };
    // The title bar is a band over the top of the main area: the line sits in the page's own frame, which starts under
    // it — before, a bare line drew from the top edge, over the App's name and the window's buttons.
    expect(renderToStaticMarkup(<appView.MainPanel />)).toMatch(/data-testid="app-page"[^>]*>[^]*extensions\.turnOnInSettings/);
    expect(renderToStaticMarkup(<appView.MainPanel />)).toContain(`padding-top:${WINDOW_CONTROL_BAR_HEIGHT_PX}px`);
    expect(mocks.claims).toEqual([]);
  });

  it('both places of the rail are drawn without the task list beside them', () => {
    expect(appView.withoutSessionSidebar).toBe(true);
    expect(appsView.withoutSessionSidebar).toBe(true);
  });
});
