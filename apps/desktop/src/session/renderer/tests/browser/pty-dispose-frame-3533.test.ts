/**
 * FrontendPty's post-mount repaint frame must belong to the FrontendPty that
 * scheduled it — and must not outlive it.
 *
 * mount() defers a repaint to the next animation frame. dispose() can land in
 * between. If that orphan frame still calls terminal.refresh(), xterm re-arms a
 * RenderDebouncer that RenderService.dispose() has already torn down; the frame
 * it schedules then runs the Viewport refresh callbacks left behind in the
 * debouncer, and Viewport._sync reads RenderService.dimensions on a cleared
 * renderer → `Cannot read properties of undefined (reading 'dimensions')`,
 * thrown in a frame no test is awaiting. See #3533.
 *
 * These run in a real Chromium process, so requestAnimationFrame is the real
 * scheduler and the ordering under test is the real one.
 */
import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function getPtyModule() {
  const pty = await import('@renderer/lib/pty/pty');
  await pty.loadXterm();
  return pty;
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await nextFrame();
}

describe('FrontendPty post-mount repaint frame ownership (#3533)', () => {
  let mountTarget: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ success: true, data: { buffer: '' } })),
    });

    for (const v of [
      '--xterm-bg',
      '--xterm-fg',
      '--xterm-cursor',
      '--xterm-cursor-accent',
      '--xterm-selection-bg',
      '--xterm-selection-fg',
    ]) {
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

  // The live path. Without this the "no touch after dispose" case below could be
  // satisfied by deleting the repaint frame outright, which is deleting the
  // behaviour rather than fixing the lifetime.
  it('repaints on the frame after a live mount', async () => {
    const refresh = vi.spyOn(Terminal.prototype, 'refresh');
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('mount-repaint');

    pty.mount(mountTarget);
    expect(refresh).not.toHaveBeenCalled(); // deferred, not synchronous

    await waitForFrames(2);
    expect(refresh).toHaveBeenCalledWith(0, pty.terminal.rows - 1);
  });

  // The bug. dispose() lands between mount() and its frame — deterministically,
  // because both happen in the same tick.
  it('does not touch the terminal on a frame scheduled before dispose', async () => {
    const refresh = vi.spyOn(Terminal.prototype, 'refresh');
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('dispose-before-frame');

    pty.mount(mountTarget);
    pty.dispose();

    await waitForFrames(3);
    expect(refresh).not.toHaveBeenCalled();
  });

  // A remount before the previous frame runs must not leave two frames pending:
  // the first one's terminal is still alive, so a plain "is it disposed" guard
  // would not catch it, yet it is the same orphan-frame shape.
  it('keeps at most one pending repaint frame across a remount', async () => {
    const refresh = vi.spyOn(Terminal.prototype, 'refresh');
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('remount-coalesce');

    const second = document.createElement('div');
    Object.assign(second.style, { width: '640px', height: '320px' });
    document.body.appendChild(second);

    pty.mount(mountTarget);
    pty.mount(second);

    await waitForFrames(3);
    expect(refresh).toHaveBeenCalledTimes(1);

    second.remove();
  });

  // The other way back into the same crash: mounting an instance that is already
  // gone. The product never does it (a reconnect builds a new FrontendPty), so
  // reaching it is a caller bug and must be loud rather than repaint a corpse.
  it('refuses to mount a disposed pty instead of repainting a dead terminal', async () => {
    const refresh = vi.spyOn(Terminal.prototype, 'refresh');
    const { FrontendPty } = await getPtyModule();
    const pty = new FrontendPty('mount-after-dispose');

    pty.dispose();
    expect(() => pty.mount(mountTarget)).toThrow(/disposed/);

    await waitForFrames(3);
    expect(refresh).not.toHaveBeenCalled();
    expect(pty.ownedContainer.isConnected).toBe(false);
  });

  // The symptom the mechanism above produces: the exact uncaught TypeError from
  // #3533, thrown in a frame outside every test's await. The assertions above
  // are on our side of the boundary and hold whatever xterm does internally;
  // this one reproduces xterm's actual throw, so the two together say both
  // "we stopped doing it" and "the thing it caused is gone".
  it('leaves no uncaught RenderService error behind a mount/dispose in one tick', async () => {
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(String(event.message));
    window.addEventListener('error', onError);

    try {
      const { FrontendPty } = await getPtyModule();
      const pty = new FrontendPty('dispose-uncaught');

      pty.mount(mountTarget);
      // The throw only happens while the renderer is live: RenderService skips
      // refreshRows entirely when its IntersectionObserver has it paused, and a
      // paused service never arms the debouncer. Waiting for that observer is
      // therefore a precondition of measuring anything — if it never settles
      // this reading is void, so say so instead of passing.
      const renderService = (
        pty.terminal as unknown as { _core: { _renderService?: { _isPaused?: boolean } } }
      )._core._renderService;
      for (let i = 0; i < 30 && renderService?._isPaused !== false; i += 1) await nextFrame();
      expect(
        renderService?._isPaused,
        'RenderService never left its paused state; this run measured nothing'
      ).toBe(false);

      // Leave a Viewport refresh callback queued in the debouncer: scrolled
      // output is what puts one there in the product.
      await new Promise<void>((resolve) => {
        pty.terminal.write('line\r\n'.repeat(200), () => resolve());
      });
      await waitForFrames(2);
      pty.terminal.scrollToTop();

      // Schedule the repaint frame and destroy the terminal in the same tick.
      pty.mount(mountTarget);
      pty.dispose();
      await waitForFrames(6);

      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', onError);
    }
  });
});
