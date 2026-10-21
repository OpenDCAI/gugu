/**
 * A mounted FrontendPty on a shown page draws with WebGL (@@@webgl-while-mounted in pty.ts), and a grid change must not leave a
 * blank canvas on screen (@@@webgl-paint-on-resize).
 *
 * Changing the canvas size clears a WebGL drawing buffer; xterm only redraws on its next animation frame. The grid
 * changes inside ResizeObserver callbacks, after this frame's animation callbacks have run, so without a repaint in
 * the same task the frame that reaches the screen is the cleared canvas — the flash seen on every sidebar toggle.
 * The repaint goes straight to the renderer through the private `_core._renderService._renderer.value.renderRows`
 * (RenderService's own `_renderRows` skips drawing inside a DEC 2026 block, which is when TUIs repaint after a resize):
 * xterm 6.0.0 has no public synchronous render (`terminal.refresh` queues an animation frame). This file pins that
 * path, so an xterm upgrade that drops it fails here instead of on a user's first resize. Runs in real Chromium: the WebGL context and the cleared buffer are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function glContextOf(element: HTMLElement): WebGL2RenderingContext {
  // Canvases under .xterm-screen already have their context (WebGL glyphs or the 2D link layer), so asking for
  // 'webgl2' returns the existing WebGL context or null; it never creates one.
  for (const canvas of element.querySelectorAll('canvas')) {
    const gl = canvas.getContext('webgl2');
    if (gl) return gl;
  }
  throw new Error('mounted terminal has no WebGL canvas');
}

/** Pixels the last draw left in the drawing buffer (alpha > 0); a cleared buffer is all transparent. */
function paintedPixels(gl: WebGL2RenderingContext): number {
  const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let n = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n += 1;
  return n;
}

describe('FrontendPty WebGL renderer across a grid change', () => {
  let mountTarget: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ success: true, data: { buffer: '' } })),
    });
    for (const v of ['--xterm-bg', '--xterm-fg', '--xterm-cursor', '--xterm-cursor-accent', '--xterm-selection-bg', '--xterm-selection-fg']) {
      document.documentElement.style.setProperty(v, v.includes('bg') ? '#101010' : '#f0f0f0');
    }
    mountTarget = document.createElement('div');
    Object.assign(mountTarget.style, { width: '640px', height: '320px' });
    document.body.appendChild(mountTarget);
  });

  afterEach(async () => {
    const { disposeAllPtys } = await getPtyModule();
    disposeAllPtys();
    mountTarget.remove();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps the WebGL context of a hidden retained page, and gives it back on unmount', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('webgl-lifetime');
    const element = pty.terminal.element!;
    expect(() => glContextOf(element)).toThrow(/no WebGL canvas/);
    pty.mount(mountTarget);
    const gl = glContextOf(element);
    // A retained page that is hidden keeps its terminal mounted (recent-session-pages) and its context:
    // switching back must not rebuild it.
    pty.setShown(false);
    pty.setShown(true);
    expect(glContextOf(element)).toBe(gl);
    pty.unmount();
    expect(() => glContextOf(element)).toThrow(/no WebGL canvas/);
    // Hidden while off screen: mounting again stays on the DOM renderer until the page is shown.
    pty.setShown(false);
    pty.mount(mountTarget);
    expect(() => glContextOf(element)).toThrow(/no WebGL canvas/);
  });

  it('holds at most WEBGL_HOT_TERMINALS contexts: the terminal shown longest ago goes back to DOM', async () => {
    const { FrontendPty, WEBGL_HOT_TERMINALS } = await getPtyModule();
    expect(WEBGL_HOT_TERMINALS).toBe(3);
    const ptys = Array.from({ length: WEBGL_HOT_TERMINALS + 1 }, (_, i) => new FrontendPty(`webgl-hot-${i}`));
    const holding = () => ptys.filter((p) => { try { glContextOf(p.terminal.element!); return true } catch { return false } });
    const show = (pty: InstanceType<typeof FrontendPty>) => {
      // like switching between task pages: the previous one is hidden, this one is shown
      ptys.forEach((other) => other !== pty && other.setShown(false));
      pty.setShown(true);
    };
    for (const pty of ptys.slice(0, WEBGL_HOT_TERMINALS)) {
      show(pty);
      pty.mount(mountTarget);
    }
    expect(holding()).toEqual(ptys.slice(0, WEBGL_HOT_TERMINALS));
    // the 4th terminal takes the context of the one shown longest ago, not of the last one shown
    show(ptys[1]);
    show(ptys[WEBGL_HOT_TERMINALS]);
    ptys[WEBGL_HOT_TERMINALS].mount(mountTarget);
    expect(holding()).toEqual([ptys[1], ptys[2], ptys[3]]);
    // showing the evicted one again takes a context back from the next one shown longest ago
    show(ptys[0]);
    expect(holding()).toEqual([ptys[0], ptys[1], ptys[3]]);
  });

  it('paints the new grid in the same task as the resize', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('webgl-resize');
    pty.mount(mountTarget);
    await new Promise<void>((resolve) => pty.terminal.write('resize keeps the picture\r\n'.repeat(5), resolve));
    await nextFrame();
    await nextFrame();
    const gl = glContextOf(pty.terminal.element!);

    pty.terminal.resize(pty.terminal.cols - 10, pty.terminal.rows - 2);

    // No frame has run since the resize: what is in the buffer now is what this frame would put on screen.
    expect(paintedPixels(gl)).toBeGreaterThan(0);
  });

  it('paints the new grid even inside a synchronized-output block', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('webgl-resize-sync');
    pty.mount(mountTarget);
    await new Promise<void>((resolve) => pty.terminal.write('resize keeps the picture\r\n'.repeat(5), resolve));
    await nextFrame();
    await nextFrame();
    // A TUI that answered the previous resize with a repaint is mid-block when the next resize lands.
    await new Promise<void>((resolve) => pty.terminal.write('\x1b[?2026h', resolve));
    const gl = glContextOf(pty.terminal.element!);

    pty.terminal.resize(pty.terminal.cols - 10, pty.terminal.rows - 2);

    expect(paintedPixels(gl)).toBeGreaterThan(0);
  });

  it('relies on a renderer entry this xterm has', async () => {
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('webgl-private-entry');
    pty.mount(mountTarget);
    const renderService = (pty.terminal as unknown as { _core: { _renderService: { _renderer?: { value?: { renderRows?: unknown } } } } })._core._renderService;
    expect(typeof renderService._renderer?.value?.renderRows).toBe('function');
  });
});
