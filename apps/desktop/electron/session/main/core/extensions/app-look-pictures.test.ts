import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * app_check's pictures (extension-look-picture.ts): the agent that wrote an App sees it before it tells the person it is
 * done — where it opens (here a group's panel, 520 wide) and on a phone (412, touch), light and dark, through the same
 * context every page gets; then back in the person's theme at its own size, to be gone on with (owner 10-13). Off screen:
 * the hidden page's width is set through device metrics, never the window. On a fake clock.
 * What the answer says about them: extension-agent-actions.test.ts; how they reach the agent: appLookPictures.test.ts.
 */

// The hidden window guide apps-ui's picture is drawn in: what it loaded, and that it is gone after.
const windows = vi.hoisted(() => [] as { loaded: string[]; destroyed: boolean; heights: number[] }[]);
vi.mock('electron', () => ({
  BrowserWindow: class {
    record = { loaded: [] as string[], destroyed: false, heights: [] as number[] };
    webContents: unknown;
    constructor() {
      windows.push(this.record);
      const record = this.record;
      this.webContents = {
        setWindowOpenHandler: () => undefined,
        on: () => undefined,
        debugger: {
          isAttached: () => true,
          attach: () => undefined,
          detach: () => undefined,
          on: () => undefined,
          once: () => undefined,
          removeListener: () => undefined,
          sendCommand: async (method: string, params: { height?: number }) => void (method === 'Emulation.setDeviceMetricsOverride' && record.heights.push(params.height!)),
        },
        executeJavaScript: async () => 1424, // the gallery's height at 440 wide
        capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 440, height: 1424 }), toJPEG: () => Buffer.from('look') }),
        isDestroyed: () => record.destroyed,
      };
    }
    loadFile = async (file: string) => void this.record.loaded.push(file);
    isDestroyed = () => this.record.destroyed;
    destroy = () => void (this.record.destroyed = true);
  },
}));
vi.mock('./app-runtime-dir', () => ({ appRuntimeDir: () => '/runtime' }));
const warned = vi.hoisted(() => [] as string[]);
vi.mock('@main/lib/logger', () => ({ log: { warn: (message: string) => void warned.push(message) } }));

const { picturesOf, lookGalleryPicture, endPictures, PICTURE_MAX_HEIGHT, GROUP_PANEL, PHONE } = await import('./extension-look-picture');
const SIZES = [GROUP_PANEL, PHONE];
const { APP_RUNTIME_VERSION } = await import('@shared/extensions/app-runtime-protocol');

type Listener = (...args: unknown[]) => void;
/** A hidden page: it takes a theme when told (unless `stubborn`), is `height` tall, and records what was done to it. */
function page(height: number, stubborn = false, displayScale = 1) {
  const state = { theme: 'dark' as string, commands: [] as { method: string; params: Record<string, unknown> }[], attached: false, resized: [] as number[], failing: new Set<string>() };
  const listeners = { message: [] as Listener[], detach: [] as Listener[] };
  const contents = {
    debugger: {
      isAttached: () => state.attached,
      attach: () => void (state.attached = true),
      detach: () => {
        state.attached = false;
        for (const listener of listeners.detach.splice(0)) listener({}, 'target closed');
      },
      on: (event: 'message', listener: Listener) => void listeners[event].push(listener),
      once: (event: 'detach', listener: Listener) => void listeners[event].push(listener),
      removeListener: (event: 'message', listener: Listener) => void (listeners[event] = listeners[event].filter((one) => one !== listener)),
      sendCommand: async (method: string, params: Record<string, unknown>) => {
        state.commands.push({ method, params });
        if (state.failing.has(method)) throw new Error(`${method} failed`);
      },
    },
    executeJavaScript: async (script: string) => (script.includes('guguTheme') ? state.theme : height),
    // At the display's scale, as Electron captures a hidden window; `resize` gives back the size it was asked for.
    capturePage: async () => {
      const width = (state.commands.filter(({ method }) => method === 'Emulation.setDeviceMetricsOverride').at(-1)!.params.width as number) * displayScale;
      const image = (w: number) => ({
        isEmpty: () => false,
        getSize: () => ({ width: w, height }),
        resize: ({ width: to }: { width: number }) => (state.resized.push(to), image(to)),
        toJPEG: (quality: number) => Buffer.from(`jpeg q${quality} ${w}w`),
      });
      return image(width);
    },
    isDestroyed: () => false,
  };
  // null: back to the person's own theme, which the context already carries.
  const showInTheme = vi.fn((theme: 'light' | 'dark' | null) => {
    if (!stubborn && theme) state.theme = theme;
  });
  const sent = (method: string) => state.commands.filter((command) => command.method === method).map(({ params }) => params);
  /** The page's screencast hands over a frame, as Chromium does once the previous one was acknowledged. */
  const frame = (sessionId: number) => listeners.message.forEach((listener) => listener({}, 'Page.screencastFrame', { sessionId, data: '' }));
  return { contents: contents as never, sent, showInTheme, frame, state };
}

beforeEach(() => {
  vi.useFakeTimers();
  warned.splice(0);
});
afterEach(() => vi.useRealTimers());

describe('app_check takes pictures of the page', () => {
  it('light then dark, where it opens then on a phone (touch), each said by its label; then back as it was', async () => {
    const { contents, sent, showInTheme } = page(600);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    const pictures = await taking;
    expect(pictures.map(({ label }) => label)).toEqual([
      '520 wide (a group\'s side panel), light',
      '412 wide (a phone, touch), light',
      '520 wide (a group\'s side panel), dark',
      '412 wide (a phone, touch), dark',
    ]);
    expect(pictures[0]).toEqual({ label: pictures[0]!.label, mimeType: 'image/jpeg', data: Buffer.from('jpeg q60 520w').toString('base64') });
    const metrics = sent('Emulation.setDeviceMetricsOverride');
    expect(metrics).toContainEqual({ width: 520, height: 600, deviceScaleFactor: 1, mobile: false });
    expect(metrics).toContainEqual({ width: 412, height: 600, deviceScaleFactor: 1, mobile: false });
    // Left in the person's theme (null: the context's own) at the first size, mouse again.
    expect(showInTheme.mock.calls.map(([theme]) => theme)).toEqual(['light', 'dark', null]);
    expect(metrics.at(-1)).toEqual({ width: 520, height: PICTURE_MAX_HEIGHT, deviceScaleFactor: 1, mobile: false });
    expect(sent('Emulation.setTouchEmulationEnabled').map(({ enabled }) => enabled)).toEqual([false, true, false, true, false]);
  });

  // #7126: on the phone an App runs in a frame as wide as its slot, where its own viewport line does nothing — a phone
  // emulated as a device (`mobile: true`) read it, and laid a page without one out at 980.
  it('the phone\'s picture is the page in a frame at the phone\'s width, touch on — never a phone browser\'s top page', async () => {
    const { contents, sent, showInTheme } = page(600);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    await taking;
    expect(sent('Emulation.setDeviceMetricsOverride').filter(({ mobile }) => mobile !== false)).toEqual([]);
    expect(sent('Emulation.setTouchEmulationEnabled')).toContainEqual({ enabled: true, maxTouchPoints: 5 });
  });

  it('a long page: its top PICTURE_MAX_HEIGHT only — every picture goes into an agent\'s context', async () => {
    const { contents, sent, showInTheme } = page(5000);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    await taking;
    const heights = new Set(sent('Emulation.setDeviceMetricsOverride').map(({ height }) => height));
    expect([...heights]).toEqual([PICTURE_MAX_HEIGHT]);
  });

  // #7126: a never-shown window got almost no frames of its own on Windows (Chole 10-12: 0 in 600 ms), so what moves by
  // frames was pictured at its first step. A screencast asks the page for frames whatever its window does (win-dev and
  // mac1: ~15 in each picture's 250 ms); its frames are only there to make the page draw.
  it('keeps the hidden page drawing: a screencast as small as it comes, before the first picture, every frame answered', async () => {
    const { contents, sent, showInTheme, frame, state } = page(600);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    await taking;
    expect(sent('Page.startScreencast')).toEqual([{ format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 }]);
    const order = state.commands.map(({ method }) => method);
    expect(order.indexOf('Page.startScreencast')).toBeLessThan(order.indexOf('Emulation.setDeviceMetricsOverride'));
    frame(7);
    expect(sent('Page.screencastFrameAck')).toEqual([{ sessionId: 7 }]);
    // Let go: the debugger is detached, which ends the screencast; nothing is left listening for its frames.
    endPictures(contents);
    frame(8);
    expect(sent('Page.screencastFrameAck')).toEqual([{ sessionId: 7 }]);
  });

  // Chole 10-12 (Windows at 150%): a 440 picture was 660 x 1350, 2.25 times the pixels an agent was meant to read.
  it('a display scaled past 100%: each picture back to one CSS pixel per pixel', async () => {
    const { contents, showInTheme, state } = page(600, false, 1.5);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    const pictures = await taking;
    expect(state.resized).toEqual([520, 412, 520, 412]);
    expect(pictures.map(({ data }) => Buffer.from(data, 'base64').toString())).toEqual(['jpeg q60 520w', 'jpeg q60 412w', 'jpeg q60 520w', 'jpeg q60 412w']);
  });

  it('control: at 100% nothing is resized', async () => {
    const { contents, showInTheme, state } = page(600);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    await taking;
    expect(state.resized).toEqual([]);
  });

  // Review 51d49fccd6: a frame left unanswered while the page is still attached stops the frames, and the pictures are
  // back at their first step — said once in gugu's log; one that arrives as the page is let go is nobody's to answer.
  it('a frame not acknowledged while attached is said once in the log; after the page is let go, it is not', async () => {
    const { contents, showInTheme, frame, state } = page(600);
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    await taking;
    state.failing.add('Page.screencastFrameAck');
    // Detached before its listener went (the frame raced the detach): nobody to answer, nothing to say.
    state.attached = false;
    frame(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(warned).toEqual([]);
    // Still attached, and unanswered: said — once, however many frames follow.
    state.attached = true;
    frame(2);
    frame(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(warned).toEqual(['app_check: a screencast frame was not acknowledged, so the hidden page may stop drawing']);
  });

  it('a screencast that does not start: the pictures are still taken, as before, and the log says why', async () => {
    const { contents, showInTheme, state } = page(600);
    state.failing.add('Page.startScreencast');
    const taking = picturesOf(contents, SIZES, showInTheme);
    await vi.advanceTimersByTimeAsync(10_000);
    const pictures = await taking;
    expect(pictures).toHaveLength(4);
    expect(new Set(warned)).toEqual(new Set(['app_check could not keep the page drawing for its pictures']));
  });

  it('a page that does not take the theme (no ui.js): said, not pictured in the wrong one', async () => {
    const { contents, sent, showInTheme } = page(600, true);
    const taking = picturesOf(contents, SIZES, showInTheme).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(String(await taking)).toMatch(/the page did not take the light theme within 2000 ms/);
    expect(sent('Emulation.setDeviceMetricsOverride')).toEqual([]);
  });
});

// Acceptance 10-05: an agent's guide_read apps-ui came back without its picture — the window loaded
// <runtime>/gallery.html, where the build puts it under the runtime's version (/_gugu/1/gallery.html).
describe('guide apps-ui\'s picture of the look', () => {
  it('is drawn from this build\'s gallery, under the runtime\'s version, in a window that is gone after', async () => {
    const taking = lookGalleryPicture();
    await vi.advanceTimersByTimeAsync(10_000);
    const picture = await taking;
    expect(windows.at(-1)!.loaded).toEqual([path.join('/runtime', APP_RUNTIME_VERSION, 'gallery.html')]);
    // Whole: the gallery's point is every piece (the first agent to read it got only its top 900 px).
    expect(Math.max(...windows.at(-1)!.heights)).toBe(1424);
    expect(windows.at(-1)!.destroyed).toBe(true);
    expect(picture).toMatchObject({ mimeType: 'image/jpeg', data: Buffer.from('look').toString('base64') });
    expect(picture.label).toMatch(new RegExp(`runtime ${APP_RUNTIME_VERSION}`));
  });
});
