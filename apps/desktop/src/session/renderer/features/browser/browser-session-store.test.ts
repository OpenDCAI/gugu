import { describe, expect, it } from 'vitest';
import { BrowserSessionStore } from './browser-session-store';

function setup() {
  const store = new BrowserSessionStore();
  const session = store.createSession({
    projectId: 'remote:dev-1',
    workspaceId: 'conv-1',
    sessionId: 'conv-1',
    initialUrl: 'file:///root/proj/index.html',
  });
  return { store, browserId: session.browserId };
}

// #6264 别的机器上的网页:页签加载的是 gugu-preview 地址,地址栏要显示人要开的 file: 地址。
describe('BrowserSessionStore url presenter', () => {
  const present = (url: string) =>
    url.startsWith('gugu-preview://p1/') ? `file:///root/proj/${url.slice('gugu-preview://p1/'.length)}` : null;

  it('records the presented address for every url written in (navigation, load errors)', () => {
    const { store, browserId } = setup();
    store.setUrlPresenter(browserId, present);
    store.updateSession(browserId, { currentUrl: 'gugu-preview://p1/docs/b.html' });
    expect(store.getSession(browserId)?.currentUrl).toBe('file:///root/proj/docs/b.html');
    store.updateSession(browserId, { loadError: { description: 'x', url: 'gugu-preview://p1/c.html' } });
    expect(store.getSession(browserId)?.loadError?.url).toBe('file:///root/proj/c.html');
  });

  it('leaves other addresses alone, and stops presenting once removed', () => {
    const { store, browserId } = setup();
    store.setUrlPresenter(browserId, present);
    store.updateSession(browserId, { currentUrl: 'https://example.com/' });
    expect(store.getSession(browserId)?.currentUrl).toBe('https://example.com/');
    store.setUrlPresenter(browserId, null);
    store.updateSession(browserId, { currentUrl: 'http://localhost:3000/' });
    expect(store.getSession(browserId)?.currentUrl).toBe('http://localhost:3000/');
  });

  it('without a presenter an internal address never replaces the one shown (it is not a tab url)', () => {
    const { store, browserId } = setup();
    store.updateSession(browserId, { currentUrl: 'gugu-preview://p1/a.html' });
    expect(store.getSession(browserId)?.currentUrl).toBe('file:///root/proj/index.html');
  });
});
