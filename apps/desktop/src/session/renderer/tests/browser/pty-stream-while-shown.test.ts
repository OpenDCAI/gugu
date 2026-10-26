import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

describe('FrontendPty streams live output only while shown', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let liveDataListener: ((data: string) => void) | null;

  beforeEach(() => {
    liveDataListener = null;
    invoke = vi.fn((channel: string) => channel === 'pty.subscribe'
      ? Promise.resolve({ success: true, data: { buffer: 'screen', live: '', size: null } })
      : Promise.resolve({ success: true, data: {} }));
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn((channel: string, callback: (data: unknown) => void) => {
        if (!channel.startsWith('pty:data.')) return () => {};
        liveDataListener = callback as (data: string) => void;
        return () => { liveDataListener = null; };
      }),
      eventSend: vi.fn(),
      invoke,
    });
  });

  afterEach(async () => {
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
    document.querySelector('[data-terminal-host="true"]')?.remove();
    document.querySelectorAll('[data-test-terminal]').forEach((el) => el.remove());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const calls = (name: string) => invoke.mock.calls.filter(([channel]) => channel === name).length;
  async function opened() {
    const { FrontendPty } = await getPtyModule();
    const target = document.createElement('div');
    target.setAttribute('data-test-terminal', '');
    target.style.cssText = 'width:640px;height:300px';
    document.body.appendChild(target);
    const pty = new FrontendPty('terminal');
    pty.mount(target);
    await pty.connect();
    await until('terminal stream attached', () => liveDataListener !== null);
    return { pty, target };
  }

  it('unsubscribes immediately when hidden and restores the snapshot when shown', async () => {
    const { pty } = await opened();
    pty.setShown(false);
    expect(liveDataListener).toBeNull();
    expect(calls('pty.unsubscribe')).toBe(1);
    const reset = vi.spyOn(pty.terminal, 'reset');
    pty.setShown(true);
    await until('stream reattached', () => liveDataListener !== null);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(calls('pty.subscribe')).toBe(2);
  });

  it('uses the retained surface visibility observer without a separate pause timer', async () => {
    const { target } = await opened();
    target.style.contentVisibility = 'hidden';
    await until('retained surface paused', () => liveDataListener === null);
    target.style.contentVisibility = 'visible';
    await until('retained surface resumed', () => liveDataListener !== null);
  });

  it('uses the existing native-window visibility event', async () => {
    await opened();
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
    expect(liveDataListener).toBeNull();
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
    await until('window stream resumed', () => liveDataListener !== null);
  });

  it('tracks the owning window after a terminal is moved to another document', async () => {
    const { pty } = await opened();
    const frame = document.createElement('iframe');
    frame.setAttribute('data-test-terminal', '');
    frame.style.cssText = 'width:700px;height:400px';
    document.body.appendChild(frame);
    const target = frame.contentDocument!.body;
    pty.mount(target);
    const view = frame.contentWindow!;
    window.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
    expect(liveDataListener).not.toBeNull();
    view.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: false }));
    expect(liveDataListener).toBeNull();
    view.dispatchEvent(new CustomEvent(ANIMATION_WINDOW_SEEN_EVENT, { detail: true }));
    await until('owning window resumed', () => liveDataListener !== null);
  });

  it('unmounting unsubscribes too', async () => {
    const { pty } = await opened();
    pty.unmount();
    expect(liveDataListener).toBeNull();
  });

  it('does not retry a rejected subscription inside its own completion handler', async () => {
    const { FrontendPty } = await getPtyModule();
    const target = document.createElement('div');
    target.setAttribute('data-test-terminal', '');
    document.body.appendChild(target);
    const pty = new FrontendPty('terminal');
    pty.mount(target);
    let subscriptions = 0;
    invoke.mockImplementation((channel: string) => channel === 'pty.subscribe'
      ? ++subscriptions === 1 ? Promise.reject(new Error('host offline')) : new Promise(() => {})
      : Promise.resolve({ success: true, data: {} }));
    await expect(pty.connect()).rejects.toThrow('host offline');
    expect(subscriptions).toBe(1);
  });
});
