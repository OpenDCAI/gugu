import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionpagePaneOpenEvent } from '@gugu/session-core/session-record/contract';
import {
  MAX_QUEUED_SESSIONS,
  MAX_QUEUED_PER_SESSION,
  QUEUED_TTL_MS,
  RemotePaneError,
  createRemotePaneRoute,
  describeRemotePaneFailure,
  isRemotePageTarget,
} from './remote-pane';

const file = (path: string) => ({ kind: 'file' as const, path });
const page = (url: string) => ({ kind: 'browser' as const, url });

function setup(options: Parameters<typeof createRemotePaneRoute>[0] = {}) {
  let id = 0;
  let clock = 1_000;
  const route = createRemotePaneRoute({ newId: () => `req-${++id}`, now: () => clock, ...options });
  const published: SessionpagePaneOpenEvent[] = [];
  const view = (subscriptionId: string, sessionId: string, browser: boolean, pages = browser) =>
    route.subscribe({ subscriptionId, sessionId, browser, pages }, (event) => published.push(event));
  return { route, published, view, advance: (ms: number) => (clock += ms) };
}

afterEach(() => vi.useRealTimers());

describe('remote pane route', () => {
  it('carries live tabs on open and uses just the newest capable viewer for list and close', async () => {
    const { route, published, advance } = setup();
    const tabs = [{ tab_id: 'report', title: 'Report', kind: 'file', closable: true }];
    route.subscribe({ subscriptionId: 'old', sessionId: 's', browser: true, tabs: true }, (event) => published.push(event));
    advance(1);
    route.subscribe({ subscriptionId: 'new', sessionId: 's', browser: true, tabs: true }, (event) => published.push(event));
    const opening = route.open('s', file('/srv/report'), 'pinned');
    route.ack({ requestId: 'req-1', subscriptionId: 'new', ok: true, tabs });
    await expect(opening).resolves.toEqual({ opened: true, tabs });
    published.length = 0;
    const listing = route.open('s', { kind: 'tabs' }, 'pinned');
    expect(published.map((event) => event.subscriptionId)).toEqual(['new']);
    route.ack({ requestId: 'req-2', subscriptionId: 'new', ok: true, tabs });
    await expect(listing).resolves.toEqual({ opened: true, tabs });
    published.length = 0;
    const closing = route.open('s', { kind: 'close-tab', tabId: 'report' }, 'pinned');
    expect(published.map((event) => event.subscriptionId)).toEqual(['new']);
    route.ack({ requestId: 'req-3', subscriptionId: 'new', ok: true, tabs, closed: false });
    await expect(closing).resolves.toEqual({ opened: true, tabs, closed: false });
  });

  it('never queues list/close, and preserves a close refusal rather than reopening later', async () => {
    const { route, published, view } = setup();
    await expect(route.open('s', { kind: 'tabs' }, 'pinned')).rejects.toThrow('No Gugu window');
    await expect(route.open('s', { kind: 'close-tab', tabId: 'x' }, 'pinned')).rejects.toThrow('No Gugu window');
    expect(view('old', 's', true).pending).toEqual([]);
    await expect(route.open('s', { kind: 'tabs' }, 'pinned')).rejects.toThrow('too old');
    route.subscribe({ subscriptionId: 'new', sessionId: 's', browser: true, tabs: true }, (event) => published.push(event));
    const rejected = route.open('s', { kind: 'close-tab', tabId: 'chat' }, 'pinned');
    const event = published.at(-1)!;
    route.ack({ requestId: event.request.requestId, subscriptionId: 'new', ok: false, failure: 'open_failed', error: 'The conversation tab cannot be closed' });
    await expect(rejected).rejects.toThrow('conversation tab');
    const disconnected = route.open('s', { kind: 'close-tab', tabId: 'report' }, 'pinned');
    route.unsubscribe('new');
    await expect(disconnected).rejects.toThrow('disconnected');
    expect(view('next', 's', true).pending).toEqual([]);
  });

  it('allows time for the existing unsaved-file confirmation', async () => {
    vi.useFakeTimers();
    const { route, published } = setup();
    route.subscribe({ subscriptionId: 'a', sessionId: 's', browser: false, tabs: true }, (event) => published.push(event));
    const closing = route.open('s', { kind: 'close-tab', tabId: 'file' }, 'pinned');
    await vi.advanceTimersByTimeAsync(20_000);
    route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: true, tabs: [], closed: true });
    await expect(closing).resolves.toEqual({ opened: true, tabs: [], closed: true });
  });

  it('pushes to the desktop viewing the session and resolves on its ack', async () => {
    const { route, published, view } = setup();
    view('sub-a', 'conv-1', true);
    view('sub-b', 'conv-2', true);
    const opening = route.open('conv-1', file('/srv/app/a.ts'), 'pinned');
    await Promise.resolve();
    expect(published).toEqual([
      {
        type: 'taskpage.pane.open',
        subscriptionId: 'sub-a',
        request: { requestId: 'req-1', sessionId: 'conv-1', target: file('/srv/app/a.ts'), intent: 'pinned' },
      },
    ]);
    expect(route.ack({ requestId: 'req-1', subscriptionId: 'sub-a', ok: true })).toBe(true);
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it('queues when no one is watching and hands the queue to the next desktop that opens the session', async () => {
    const { route, view, published } = setup();
    await expect(route.open('conv-1', file('/srv/app/a.ts'), 'preview')).resolves.toEqual({ queued: true });
    await expect(route.open('conv-1', page('https://example.com/'), 'pinned')).resolves.toEqual({ queued: true });
    expect(published).toEqual([]);
    expect(view('sub-a', 'conv-1', true).pending.map((request) => request.target)).toEqual([
      file('/srv/app/a.ts'),
      page('https://example.com/'),
    ]);
    // Delivered once: a second desktop does not get the same tabs again.
    expect(view('sub-b', 'conv-1', true).pending).toEqual([]);
  });

  it('keeps a page for a desktop that has a browser tab when the first viewer has none', async () => {
    const { route, view } = setup();
    await route.open('conv-1', page('http://localhost:3000/'), 'pinned');
    await route.open('conv-1', file('/srv/app/a.ts'), 'pinned');
    expect(view('tunnel-desktop', 'conv-1', false).pending.map((request) => request.target.kind)).toEqual(['file']);
    expect(view('ssh-desktop', 'conv-1', true).pending.map((request) => request.target.kind)).toEqual(['browser']);
  });

  it('updates a subscription subscribed again in place: watched throughout, and a page kept for a browser tab is handed over', async () => {
    const { route, view } = setup();
    await route.open('conv-1', page('http://localhost:3000/'), 'pinned');
    expect(view('sub-a', 'conv-1', false).pending).toEqual([]);
    expect(route.watching('conv-1')).toBe(true);
    // The tunnel came up on that desktop: the same subscription, now with a browser tab.
    expect(view('sub-a', 'conv-1', true).pending.map((request) => request.target.kind)).toEqual(['browser']);
    expect(route.watching('conv-1')).toBe(true);
    // Still one viewer, not two: one unsubscribe and nobody watches.
    expect(route.unsubscribe('sub-a')).toBe(true);
    expect(route.watching('conv-1')).toBe(false);
  });

  it('fails a page at once when the only viewers have no browser tab — no push, no wait', async () => {
    const { route, view, published } = setup();
    view('sub-a', 'conv-1', false);
    await expect(route.open('conv-1', page('https://example.com/'), 'pinned')).rejects.toMatchObject({ code: 'no_browser' });
    expect(published).toEqual([]);
  });

  it('fails a page at once when nobody watches but every desktop seen so far lacks a browser tab', async () => {
    const { route, view } = setup();
    view('sub-a', 'conv-other', false);
    route.unsubscribe('sub-a');
    await expect(route.open('conv-1', page('https://example.com/'), 'pinned')).rejects.toMatchObject({ code: 'no_browser' });
    // Files are still fine.
    await expect(route.open('conv-1', file('/srv/a'), 'pinned')).resolves.toEqual({ queued: true });
  });

  it('only pushes a page to the viewers that can open it', async () => {
    const { route, view, published } = setup();
    view('tunnel', 'conv-1', false);
    view('ssh', 'conv-1', true);
    const opening = route.open('conv-1', page('http://localhost:5173/'), 'pinned');
    expect(published.map((event) => event.subscriptionId)).toEqual(['ssh']);
    route.ack({ requestId: 'req-1', subscriptionId: 'ssh', ok: true });
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it('succeeds on the first ok and fails only when every viewer said no', async () => {
    const { route, view } = setup();
    view('a', 'conv-1', true);
    view('b', 'conv-1', true);
    const first = route.open('conv-1', file('/srv/x'), 'pinned');
    route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: false, failure: 'open_failed' });
    route.ack({ requestId: 'req-1', subscriptionId: 'b', ok: true });
    await expect(first).resolves.toEqual({ opened: true });

    const second = route.open('conv-1', page('https://example.com/'), 'pinned');
    route.ack({ requestId: 'req-2', subscriptionId: 'a', ok: false, failure: 'open_failed' });
    route.ack({ requestId: 'req-2', subscriptionId: 'b', ok: false, failure: 'no_browser' });
    await expect(second).rejects.toMatchObject({ code: 'no_browser' });
  });

  it('ignores an ack from a subscription the request was not pushed to', async () => {
    const { route, view } = setup();
    view('a', 'conv-1', true);
    view('elsewhere', 'conv-2', true);
    const opening = route.open('conv-1', file('/srv/x'), 'pinned');
    expect(route.ack({ requestId: 'req-1', subscriptionId: 'elsewhere', ok: true })).toBe(false);
    expect(route.ack({ requestId: 'no-such', subscriptionId: 'a', ok: true })).toBe(false);
    route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: true });
    await expect(opening).resolves.toEqual({ opened: true });
  });

  // #6264 桌面合盖睡着 / 被杀而没退订:订阅还挂着(90 秒 + 清扫才拆),推过去没人回话。❌ 报超时让 tab 永远不出现。
  it('queues after 10s without an answer, and re-pushes when that desktop wakes up (keepalive)', async () => {
    vi.useFakeTimers();
    const { route, view, published } = setup();
    view('a', 'conv-1', true);
    const opening = route.open('conv-1', file('/srv/x'), 'pinned');
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(opening).resolves.toEqual({ queued: true, unconfirmed: true });
    expect(published).toHaveLength(1);
    // The desktop wakes: its next keepalive re-pushes the same request (same requestId, deduped on the desktop).
    expect(route.touch('a')).toBe(1);
    expect(published.at(-1)).toMatchObject({ subscriptionId: 'a', request: { requestId: 'req-1', target: file('/srv/x') } });
    // Its answer takes it out of the queue: nobody opens it a second time.
    expect(route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: true })).toBe(false);
    expect(route.touch('a')).toBe(0);
    expect(view('b', 'conv-1', true).pending).toEqual([]);
  });

  it('hands a request that timed out to the next desktop that opens the session', async () => {
    vi.useFakeTimers();
    const { route, view } = setup();
    view('a', 'conv-1', true);
    const opening = route.open('conv-1', page('https://example.com/'), 'pinned');
    await vi.advanceTimersByTimeAsync(10_000);
    await opening;
    route.unsubscribe('a');
    expect(view('b', 'conv-1', true).pending.map((request) => request.target)).toEqual([page('https://example.com/')]);
  });

  it('drops a queued request when a late answer arrives after the timeout', async () => {
    vi.useFakeTimers();
    const { route, view } = setup();
    view('a', 'conv-1', true);
    const opening = route.open('conv-1', file('/srv/x'), 'pinned');
    await vi.advanceTimersByTimeAsync(10_000);
    await opening;
    route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: true });
    route.unsubscribe('a');
    expect(view('b', 'conv-1', true).pending).toEqual([]);
  });

  it('touch is a no-op for unknown subscriptions and for requests the desktop cannot open', async () => {
    const { route, view } = setup();
    expect(route.touch('nobody')).toBe(0);
    await route.open('conv-1', page('https://example.com/'), 'pinned');
    view('tunnel', 'conv-1', false);
    expect(route.touch('tunnel')).toBe(0);
  });

  it('queues instead of failing when the viewer leaves before answering', async () => {
    const { route, view } = setup();
    view('a', 'conv-1', true);
    const opening = route.open('conv-1', file('/srv/x'), 'pinned');
    route.unsubscribe('a');
    await expect(opening).resolves.toEqual({ queued: true });
    expect(view('b', 'conv-1', true).pending.map((request) => request.target)).toEqual([file('/srv/x')]);
  });

  it('rejects with the abort reason when the tool call is cancelled', async () => {
    const { route, view } = setup();
    view('a', 'conv-1', true);
    const controller = new AbortController();
    const opening = route.open('conv-1', file('/srv/x'), 'pinned', controller.signal);
    controller.abort(new Error('grant revoked'));
    await expect(opening).rejects.toThrow('grant revoked');
  });

  it('keeps the queue bounded: newest wins per target, oldest dropped past the caps, stale entries expire', async () => {
    const { route, view, advance } = setup();
    for (let i = 0; i < MAX_QUEUED_PER_SESSION + 3; i += 1) await route.open('conv-1', file(`/srv/${i}`), 'pinned');
    await route.open('conv-1', file('/srv/12'), 'preview');
    const pending = view('a', 'conv-1', true).pending;
    expect(pending).toHaveLength(MAX_QUEUED_PER_SESSION);
    expect(pending.at(-1)).toMatchObject({ target: file('/srv/12'), intent: 'preview' });
    expect(pending[0]?.target).toEqual(file('/srv/3'));
    route.unsubscribe('a');

    for (let i = 0; i < MAX_QUEUED_SESSIONS + 1; i += 1) await route.open(`c-${i}`, file('/srv/f'), 'pinned');
    expect(view('x', 'c-0', true).pending).toEqual([]);
    expect(view('y', 'c-1', true).pending).toHaveLength(1);

    await route.open('late', file('/srv/f'), 'pinned');
    advance(QUEUED_TTL_MS + 1);
    expect(view('z', 'late', true).pending).toEqual([]);
  });

  it('gives the agent a sentence that says what to do next for every failure', () => {
    for (const code of ['no_browser', 'open_failed', 'viewer_timeout', 'no_viewer'] as const) {
      const text = describeRemotePaneFailure(code);
      expect(text.length).toBeGreaterThan(40);
      expect(new RemotePaneError(code).message).toBe(text);
    }
    expect(describeRemotePaneFailure('no_browser')).toMatch(/remote tunnel/);
  });

  // 这台机器上的网页(`file:`):只推给渲染得了它的桌面(订阅时带 pages)。老桌面拿它会去加载自己电脑上的 file:。
  describe('file:// pages from this machine', () => {
    const local = page('file:///srv/app/site/index.html');

    it('is a page target only for file: urls', () => {
      expect(isRemotePageTarget(local)).toBe(true);
      expect(isRemotePageTarget(page('http://localhost:3000/'))).toBe(false);
      expect(isRemotePageTarget(file('/srv/app/site/index.html'))).toBe(false);
    });

    it('goes to a desktop that renders pages, and not to an older one watching the same session', async () => {
      const { route, published, view } = setup();
      view('sub-old', 'conv-1', true, false);
      view('sub-new', 'conv-1', true, true);
      const opening = route.open('conv-1', local, 'pinned');
      await Promise.resolve();
      expect(published.map((event) => event.subscriptionId)).toEqual(['sub-new']);
      route.ack({ requestId: 'req-1', subscriptionId: 'sub-new', ok: true });
      await expect(opening).resolves.toEqual({ opened: true });
    });

    it('fails fast with a plain reason when only an older desktop is watching (it has a browser tab)', async () => {
      const { route, published, view } = setup();
      view('sub-old', 'conv-1', true, false);
      await expect(route.open('conv-1', local, 'pinned')).rejects.toMatchObject({ code: 'viewer_outdated' });
      expect(published).toEqual([]);
      expect(describeRemotePaneFailure('viewer_outdated')).toContain('path');
      // 同一个老桌面照样开得了 localhost 与普通网址。
      const port = route.open('conv-1', page('http://localhost:3000/'), 'pinned');
      await Promise.resolve();
      expect(published.map((event) => event.subscriptionId)).toEqual(['sub-old']);
      route.ack({ requestId: 'req-2', subscriptionId: 'sub-old', ok: true });
      await expect(port).resolves.toEqual({ opened: true });
    });

    it('stays a no_browser failure on a machine seen only through a tunnel', async () => {
      const { route, view } = setup();
      view('sub-a', 'conv-1', false, false);
      await expect(route.open('conv-1', local, 'pinned')).rejects.toMatchObject({ code: 'no_browser' });
    });

    it('waits in the queue for a desktop that renders pages', async () => {
      const { route, view } = setup();
      await expect(route.open('conv-1', local, 'preview')).resolves.toEqual({ queued: true });
      expect(view('sub-old', 'conv-1', true, false).pending).toEqual([]);
      expect(view('sub-new', 'conv-1', true, true).pending.map((request) => request.target)).toEqual([local]);
    });
  });
});

// #6264 那台机器上的程序要「打开网页」($BROWSER / xdg-open):照 VS Code 远端 openExternal,在人这一侧打开。
describe('remote pane route: open a web page on the person\'s side', () => {
  const external = (url: string) => ({ kind: 'external' as const, url });
  function setupExternal() {
    let id = 0;
    let clock = 1_000;
    const route = createRemotePaneRoute({ newId: () => `req-${++id}`, now: () => clock });
    const published: SessionpagePaneOpenEvent[] = [];
    const view = (subscriptionId: string, sessionId: string, opts: { external: boolean; browser?: boolean }) =>
      route.subscribe(
        { subscriptionId, sessionId, browser: opts.browser ?? true, pages: true, external: opts.external },
        (event) => published.push(event)
      );
    return { route, published, view, advance: (ms: number) => (clock += ms) };
  }

  it('goes to the desktop watching that session', async () => {
    const { route, published, view } = setupExternal();
    view('a', 'conv-1', { external: true });
    const opening = route.open('conv-1', external('https://github.com/login/device'), 'pinned');
    await Promise.resolve();
    expect(published[0]).toMatchObject({ subscriptionId: 'a', request: { sessionId: 'conv-1' } });
    route.ack({ requestId: 'req-1', subscriptionId: 'a', ok: true });
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it('falls back to the desktop that most recently looked at this machine when nobody watches that session', async () => {
    const { route, published, view, advance } = setupExternal();
    view('old', 'conv-2', { external: true });
    advance(1_000);
    view('recent', 'conv-3', { external: true, browser: false });
    const opening = route.open('conv-1', external('https://example.com/'), 'pinned');
    await Promise.resolve();
    expect(published).toHaveLength(1);
    // It opens as part of the session that desktop is looking at.
    expect(published[0]).toMatchObject({ subscriptionId: 'recent', request: { sessionId: 'conv-3' } });
    route.ack({ requestId: 'req-1', subscriptionId: 'recent', ok: true });
    await expect(opening).resolves.toEqual({ opened: true });
  });

  it('keeps a touched desktop as the freshest one', async () => {
    const { route, published, view, advance } = setupExternal();
    view('a', 'conv-2', { external: true });
    advance(1_000);
    view('b', 'conv-3', { external: true });
    advance(1_000);
    route.touch('a');
    void route.open('', external('https://example.com/'), 'pinned');
    await Promise.resolve();
    expect(published.at(-1)).toMatchObject({ subscriptionId: 'a' });
  });

  it('never pushes to an older desktop that does not know this kind of request', async () => {
    const { route, published, view } = setupExternal();
    view('old', 'conv-1', { external: false });
    await expect(route.open('conv-1', external('https://example.com/'), 'pinned')).rejects.toMatchObject({
      code: 'viewer_outdated',
    });
    expect(published).toEqual([]);
  });

  it('queues for the session when no desktop is around, and says so plainly when the session is unknown too', async () => {
    const { route, view } = setupExternal();
    await expect(route.open('conv-1', external('https://example.com/'), 'pinned')).resolves.toEqual({ queued: true });
    await expect(route.open('', external('https://example.com/'), 'pinned')).rejects.toMatchObject({ code: 'no_viewer' });
    expect(view('a', 'conv-1', { external: true }).pending.map((request) => request.target)).toEqual([
      external('https://example.com/'),
    ]);
  });
});
