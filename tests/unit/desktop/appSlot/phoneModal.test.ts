// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostAppFrame } from '../../../../apps/desktop/src/components/appSlot/phoneAppHost';
import { listenAppModals, type AppModalPresentation } from '../../../../apps/desktop/src/components/appModal/appModal';
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest';
import { APP_FRAME_MARKER } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol';

vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => ({}) }));
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererAccessToken: () => null }));
const manifest = parseExtensionManifest({ id: 'board', name: 'Board', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, entry: 'main.html', contributes: { tabs: [{ name: 'main', title: 'Board' }] } });
let frame: HTMLIFrameElement;
let host: ReturnType<typeof hostAppFrame>;
let stop: () => void;
let presentation: AppModalPresentation | undefined;
let child: HTMLIFrameElement | undefined;
let detach: (() => void) | undefined;
const chrome = vi.fn();
let seq = 0;
const posted = new Map<HTMLIFrameElement, ReturnType<typeof vi.fn>>();
function watch(element: HTMLIFrameElement) {
  const send = vi.fn(); posted.set(element, send);
  Object.defineProperty(element.contentWindow!, 'postMessage', { value: send, configurable: true });
}
function from(element: HTMLIFrameElement, message: Record<string, unknown>) {
  window.dispatchEvent(new MessageEvent('message', { source: element.contentWindow, origin: new URL(element.src).origin, data: { m: APP_FRAME_MARKER, ...message } }));
}
async function call(element: HTMLIFrameElement, method: string, args: Record<string, unknown> = {}) {
  const id = ++seq;
  from(element, { t: 'call', id, method, args });
  await vi.waitFor(() => expect(posted.get(element)!.mock.calls.some(([message]) => message.id === id)).toBe(true));
  return posted.get(element)!.mock.calls.map(([message]) => message).find((message) => message.id === id);
}
beforeEach(() => {
  vi.spyOn(installedExtensionsStore, 'manifestFor').mockReturnValue(manifest);
  Object.defineProperty(navigator, 'userActivation', { value: { isActive: false }, configurable: true });
  stop = listenAppModals((event) => { if (event.type === 'open') presentation = event.presentation; });
  frame = document.createElement('iframe'); frame.src = 'https://board.apps.gugu.invalid/main.html'; document.body.append(frame); watch(frame);
  host = hostAppFrame(frame, { extensionId: 'board', tabId: 'board-tab', chatId: null, capabilities: [], locale: 'en', themeMode: 'dark' }, { showMessage: vi.fn(), showSession: () => ({ shown: true }), openWith: vi.fn(), chrome });
  from(frame, { t: 'hello' }); chrome.mockClear();
});
afterEach(async () => { await presentation?.dismiss(); detach?.(); host.dispose(); stop(); frame.remove(); child?.remove(); presentation = undefined; child = undefined; detach = undefined; posted.clear(); vi.restoreAllMocks(); });

describe('App modals in the phone host', () => {
  it('uses the same sandbox origin, receives initial data and returns the form result without another gesture', async () => {
    expect(await call(frame, 'modalOpen', { id: 'phone-one', entry: 'new.html', title: 'New', data: { column: 'todo' } })).toMatchObject({ ok: true });
    expect(presentation?.url).toBe('https://board.apps.gugu.invalid/new.html');
    child = document.createElement('iframe'); child.src = presentation!.url; document.body.append(child); watch(child);
    detach = presentation!.attach(child);
    from(child, { t: 'hello' });
    expect(chrome).not.toHaveBeenCalled();
    expect(await call(child, 'getContext')).toMatchObject({ ok: true, value: { tabId: 'board-tab', modal: { data: { column: 'todo' } }, capabilities: [], layout: { fullscreen: true } } });
    expect(await call(frame, 'modalClose', { result: 'forged' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call(child, 'modalClose', { result: { cardId: 'created' } })).toMatchObject({ ok: true });
    expect(posted.get(frame)!.mock.calls.map(([message]) => message).filter((message) => message.event?.type === 'modalClosed')).toEqual([{ m: APP_FRAME_MARKER, t: 'event', event: { type: 'modalClosed', id: 'phone-one', result: { cardId: 'created' } } }]);
  });

  it('cancels a modal when its opener navigates to another document', async () => {
    await call(frame, 'modalOpen', { id: 'phone-two', entry: 'new.html', title: 'New' });
    from(frame, { t: 'hello' });
    await vi.waitFor(() => expect(posted.get(frame)!.mock.calls.map(([message]) => message).some((message) => message.event?.type === 'modalClosed' && message.event.result === null)).toBe(true));
  });
});
