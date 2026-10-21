import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

/**
 * S15 (统筹 10:20, 06:52): an App page stays on its own origin. The desktop stops the navigation in `will-navigate` —
 * the page keeps what it had, nothing is fetched — and its author hears why (reportBlockedNavigation, pointed at
 * gugu.openBrowserTab). Its own bundle's pages it may go to. It may open no window at all.
 */

const reported = vi.hoisted(() => [] as unknown[][]);
vi.mock('electron', () => ({ app: { on: () => undefined }, webContents: { getAllWebContents: () => [] } }));
vi.mock('@main/core/extensions/bridge-preload-path', () => ({ extensionBridgePreloadCandidates: () => [], resolveExtensionBridgePreload: () => null }));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'board', configuredExtensionIds: () => new Set(['board']) }));
vi.mock('@main/core/extensions/extension-bridge', () => ({ reportBlockedNavigation: (...args: unknown[]) => void reported.push(args) }));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined, error: () => undefined, info: () => undefined } }));

const { governWebContents } = await import('./webview-policy');

/** An embedder with an App page attached to it: the page's events, and what its window-open handler answers. */
function attachedAppPage() {
  const embedder = new EventEmitter();
  const page = Object.assign(new EventEmitter(), {
    id: 41,
    session: {},
    openHandler: null as (() => { action: string }) | null,
    setWindowOpenHandler(handler: () => { action: string }) {
      page.openHandler = handler;
    },
  });
  governWebContents(embedder as never);
  embedder.emit('did-attach-webview', {}, page);
  const navigate = (url: string) => {
    const event = { preventDefault: vi.fn() };
    page.emit('will-navigate', event, url);
    return event.preventDefault.mock.calls.length > 0;
  };
  return { page, navigate };
}

/** The report goes by a dynamic import: waited for until it is there (a loaded machine takes its time), not timed. */
async function reportsSettle(count: number): Promise<void> {
  for (let tries = 0; reported.length < count && tries < 4000; tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('an App page stays on its own origin (S15)', () => {
  it('going to another site is stopped, and the author is told — the address as the page tried it', async () => {
    const { navigate } = attachedAppPage();
    reported.length = 0;
    // One at a time, as navigations come: each report is waited for before the next.
    expect(navigate('https://example.com/collect?token=secret')).toBe(true);
    await reportsSettle(1);
    expect(navigate('gugu-ext://other-app/index.html')).toBe(true);
    await reportsSettle(2);
    expect(reported).toEqual([
      [41, 'https://example.com/collect?token=secret'],
      [41, 'gugu-ext://other-app/index.html'],
    ]);
  });

  it('control: a page of its own bundle is let through, and nothing is said', async () => {
    const { navigate } = attachedAppPage();
    reported.length = 0;
    expect(navigate('gugu-ext://board/settings.html')).toBe(false);
    // A stopped one after it, as a marker: reports come in order, so when it is heard the first would have been too.
    expect(navigate('https://marker.example/')).toBe(true);
    await reportsSettle(1);
    expect(reported).toEqual([[41, 'https://marker.example/']]);
  });

  it('it opens no window', () => {
    const { page } = attachedAppPage();
    expect(page.openHandler?.()).toEqual({ action: 'deny' });
  });
});
