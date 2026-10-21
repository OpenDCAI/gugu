import path from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import { APP_RUNTIME_VERSION } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionPicture } from '@shared/extensions/extension-check';
import { log } from '@main/lib/logger';
import { appRuntimeDir } from './app-runtime-dir';

/**
 * Pictures of an App page as a person would see it, for the agent that wrote it (`app_check`) and for the guide that
 * shows the look (`guide_read apps-ui`). An agent had never seen what it made; now it looks before it says it is done.
 *
 * Taken off screen: the page's own hidden window, its width set through the DevTools protocol (device metrics — the
 * window is never resized or shown), touch at a phone's width so the touch sizes apply.
 * Small on purpose, every one of them goes into an agent's context: one CSS pixel per pixel, the page's top
 * PICTURE_MAX_HEIGHT, JPEG — about 30 KB and ~500 tokens each.
 *
 * The phone's picture is laid out the way the phone lays an App out: in a frame. On the phone an App's page is an
 * <iframe> as wide as the App's slot (GroupAppSlot.tsx `FramedApp`, `w-full`; the width it is told is the frame's,
 * phoneAppHost.ts `layout.width`), and a document in a frame takes the frame's width — its own `<meta name="viewport">`
 * does nothing there. So the device is not emulated as a phone (`mobile: false`: no viewport line read, no 980 px
 * fallback), only its width and its touch (`(pointer: coarse)`, touch sizes). `mobile: true` drew a top-level page in a
 * phone's browser instead: one without a viewport line was laid out at 980 and shrunk to 412 — what no phone shows
 * (#7126).
 */
export interface PictureSize {
  width: number;
  touch: boolean;
  says: string;
}
/**
 * Where an App's page shows (owner 10-13), as wide as it is there: a group's panel opens 520 wide (groupSlotMemory.ts
 * `GROUP_PANEL_WIDTHS`); a phone's slot is its screen; a task page's tab is as wide as its pane — 952 in the 1280-wide
 * window it opens at, beside the 260 sidebar (mac1 10-13, `session_open_in_tab`).
 */
export const GROUP_PANEL: PictureSize = { width: 520, touch: false, says: '520 wide (a group\'s side panel)' };
export const PHONE: PictureSize = { width: 412, touch: true, says: '412 wide (a phone, touch)' };
/** A tab on the task page: `shown`, its width there now if it is open, else one pane of the window it opens at. */
export function taskPane(shown: number | null): PictureSize {
  return shown === null
    ? { width: 952, touch: false, says: '952 wide (a tab on the task page)' }
    : { width: shown, touch: false, says: `${shown} wide (its tab on the task page, as wide as it is shown now)` };
}
export const PICTURE_MAX_HEIGHT = 900;
const PICTURE_QUALITY = 60;
/** Long enough for a re-layout and the fonts' swap, and ~15 animation frames with `keepPainting` on. */
const SETTLE_MS = 250;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a screencast is asked for: its frames are only there to make the page draw, so as small as they come. */
const PAINT_ONLY = { format: 'jpeg', quality: 1, maxWidth: 16, maxHeight: 16, everyNthFrame: 1 } as const;
const painting = new WeakSet<WebContents>();

/**
 * Animation frames for a hidden page, as it gets them on screen (#7126). A window that was never shown gets none of its
 * own on Windows: only the one or two a resize forces and the few a capture does (Chole 10-12, 0 in 600 ms; three
 * pictures of four were the page 0–6 ms after its resize), so what moves by frames — a requestAnimationFrame loop, a
 * layout settling, an element's entrance — was pictured at its first step. macOS gives the same window ~60 a second. A
 * DevTools screencast asks the page for frames whatever its window does: ~15 in each picture's 250 ms on Windows and on
 * macOS alike (win-dev and mac1 10-12; an offscreen window gave Windows its ~15 too, but left macOS with 2–10).
 * Its frames are acknowledged and dropped. Detaching the debugger (`endPictures`) ends it.
 */
export async function keepPainting(contents: WebContents): Promise<void> {
  if (painting.has(contents)) return;
  const debug = contents.debugger;
  if (!debug.isAttached()) debug.attach('1.3');
  let warned = false;
  const ack = (_event: unknown, method: string, params: { sessionId?: number }) => {
    if (method !== 'Page.screencastFrame') return;
    // The next frame comes once this one is acknowledged. One that arrives as the page is let go has no one to answer;
    // one not answered while it is still attached stops the frames, and the pictures are back at their first step —
    // said once, in gugu's log.
    debug.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch((error: unknown) => {
      if (!debug.isAttached() || warned) return;
      warned = true;
      log.warn('app_check: a screencast frame was not acknowledged, so the hidden page may stop drawing', { message: error instanceof Error ? error.message : String(error) });
    });
  };
  debug.on('message', ack);
  try {
    await debug.sendCommand('Page.startScreencast', PAINT_ONLY);
  } catch (error) {
    debug.removeListener('message', ack);
    throw error;
  }
  debug.once('detach', () => {
    debug.removeListener('message', ack);
    painting.delete(contents);
  });
  painting.add(contents);
}

/** The page laid out at `size`, a picture's full height: its width, and touch at a phone's — as `app_check`'s steps run. */
export async function showAtSize(contents: WebContents, size: PictureSize): Promise<void> {
  const debug = contents.debugger;
  if (!debug.isAttached()) debug.attach('1.3');
  await debug.sendCommand('Emulation.setDeviceMetricsOverride', { width: size.width, height: PICTURE_MAX_HEIGHT, deviceScaleFactor: 1, mobile: false });
  await debug.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: size.touch, maxTouchPoints: size.touch ? 5 : 1 });
}

/**
 * One picture of what `contents` shows, at `size`: its top `maxHeight`. The page stays as it is otherwise; `endPictures`
 * lets it go.
 */
export async function pictureOf(contents: WebContents, size: PictureSize, label: string, maxHeight = PICTURE_MAX_HEIGHT): Promise<ExtensionPicture> {
  const debug = contents.debugger;
  try {
    await keepPainting(contents);
  } catch (error) {
    // Pictures still, as they were before frames were asked for (a hidden window on Windows: its first step); said in
    // gugu's log — ❌ every picture lost to it.
    log.warn('app_check could not keep the page drawing for its pictures', { label, message: error instanceof Error ? error.message : String(error) });
  }
  await showAtSize(contents, size);
  const metrics = (height: number) =>
    debug.sendCommand('Emulation.setDeviceMetricsOverride', { width: size.width, height, deviceScaleFactor: 1, mobile: false });
  await delay(SETTLE_MS);
  const full: unknown = await contents.executeJavaScript('document.documentElement.scrollHeight', false);
  const height = Math.max(1, Math.min(maxHeight, typeof full === 'number' ? full : PICTURE_MAX_HEIGHT));
  if (height !== PICTURE_MAX_HEIGHT) {
    await metrics(height);
    await delay(SETTLE_MS);
  }
  const captured = await contents.capturePage(undefined, { stayHidden: true });
  if (captured.isEmpty()) throw new Error(`the page drew nothing to take a picture of (${label})`);
  // A display scaled past 100% is captured at its own scale (Windows at 150%: 660 px for 440 CSS px, 2.25 times the
  // pixels — Chole and win-dev 10-12): back to one CSS pixel per pixel.
  const image = captured.getSize().width > size.width ? captured.resize({ width: size.width, quality: 'better' }) : captured;
  return { label, mimeType: 'image/jpeg', data: image.toJPEG(PICTURE_QUALITY).toString('base64') };
}

/** The context with the other theme reaches the page and its ui.js takes it: well within this. */
const THEME_WAIT_MS = 2000;
const POLL_MS = 100;

/**
 * `app_check`'s pictures: the page in light, then dark — `showInTheme` sends it the context every page gets, and ui.js
 * sets `data-gugu-theme` from it — at each of `sizes`. Waits for the page to take the theme before the pictures, and
 * leaves it in the person's theme at the first size, as it was (owner 10-13: a page is gone on with).
 */
export async function picturesOf(contents: WebContents, sizes: readonly PictureSize[], showInTheme: (theme: 'light' | 'dark' | null) => void): Promise<ExtensionPicture[]> {
  const pictures: ExtensionPicture[] = [];
  for (const theme of ['light', 'dark'] as const) {
    showInTheme(theme);
    const until = Date.now() + THEME_WAIT_MS;
    while ((await contents.executeJavaScript('document.documentElement.dataset.guguTheme', false)) !== theme) {
      if (Date.now() >= until) throw new Error(`the page did not take the ${theme} theme within ${THEME_WAIT_MS} ms`);
      await delay(POLL_MS);
    }
    for (const size of sizes) pictures.push(await pictureOf(contents, size, `${size.says}, ${theme}`));
  }
  showInTheme(null);
  await showAtSize(contents, sizes[0]!);
  return pictures;
}

/** Lets the page go back to its own size once the pictures are taken, and its screencast end (`keepPainting`). */
export function endPictures(contents: WebContents): void {
  if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
}

let lookPicture: Promise<ExtensionPicture> | null = null;
/**
 * The gallery is shown whole (it is 1424 px at 440 wide): its point is every piece, and an agent got only the top
 * 900 — no table, tabs, icons, time or empty state (acceptance, 10-05). One picture: ~60 KB, read once.
 */
export const LOOK_PICTURE_MAX_HEIGHT = 1600;

/**
 * The picture of gugu's look (`gallery.html` of this build's runtime: every element, class and component, captioned
 * with its markup) — what `guide_read apps-ui` shows. Rendered from this build the first time it is asked for, so it is
 * never out of date with the look it shows; kept for the life of the process.
 */
export function lookGalleryPicture(): Promise<ExtensionPicture> {
  lookPicture ??= takeLookPicture().catch((error: unknown) => {
    lookPicture = null;
    throw error;
  });
  return lookPicture;
}

async function takeLookPicture(): Promise<ExtensionPicture> {
  const root = appRuntimeDir();
  if (!root) throw new Error('the App runtime is missing from this build');
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { backgroundThrottling: false, sandbox: true } });
  try {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    // `root` is what `/_gugu/` maps to: the runtime's files are under its version (`/_gugu/1/gallery.html`).
    await win.loadFile(path.join(root, APP_RUNTIME_VERSION, 'gallery.html'), { query: { theme: 'light' } });
    const picture = await pictureOf(win.webContents, { width: 440, touch: false, says: '440 wide' }, `gugu's look, runtime ${APP_RUNTIME_VERSION}: every element captioned with its markup, 440 wide, light`, LOOK_PICTURE_MAX_HEIGHT);
    return picture;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
