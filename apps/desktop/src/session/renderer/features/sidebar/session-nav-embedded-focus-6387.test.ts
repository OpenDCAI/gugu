// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { sessionNavContextFor } from './session-keyboard-nav-listener';

/**
 * #6387 owner 2026-09-24「输不进去啊」: typing into an extension tab's text field landed in the
 * terminal. Electron re-dispatches keys an embedded page did not consume onto the embedder's
 * <body>, so the event path never contains the <webview> — the nav layer read it as "typing on
 * nothing" and jumped the caret into the session composer. Focus decides who owns the key.
 */

function keyOnBody(key = 'a'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true });
  document.body.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('session nav keeps its hands off embedded pages (#6387)', () => {
  it('a key re-dispatched onto <body> while a <webview> holds focus belongs to the webview', () => {
    const webview = document.createElement('webview');
    webview.tabIndex = 0;
    document.body.appendChild(webview);
    webview.focus();
    expect(document.activeElement).toBe(webview);
    expect(sessionNavContextFor(keyOnBody())).toBeNull();
  });

  it('the same for a webview inside the task page shadow root', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const webview = document.createElement('webview');
    webview.tabIndex = 0;
    root.appendChild(webview);
    webview.focus();
    expect(sessionNavContextFor(keyOnBody())).toBeNull();
  });

  it('with nothing focused, a key on <body> is still the nav layer\'s', () => {
    expect(sessionNavContextFor(keyOnBody())).toEqual({ context: 'nav', editor: null });
  });
});
