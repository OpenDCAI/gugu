// @vitest-environment jsdom
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { imeHold } from './ime-hold';

/** Stands in for `SyncLink.hold`: nested holds; the open file's frames flow once the depth is back to 0. */
function setup(options: { keyboardSession?: boolean; editContext?: boolean } = {}) {
  const link = { depth: 0, acquired: 0, flushes: 0, flushedInsideUpdate: false };
  const view = new EditorView({ parent: document.body, doc: 'hello' });
  // CodeMirror on Chrome Android 133+ edits through an EditContext (jsdom has none: this stands in for it).
  const editContext = options.editContext ? new EventTarget() : null;
  if (editContext) Object.defineProperty(view.contentDOM, 'editContext', { value: editContext, configurable: true });
  const holdRemote = () => {
    link.depth += 1;
    link.acquired += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      link.depth -= 1;
      if (link.depth > 0) return;
      link.flushes += 1;
      // Delivering the held frames dispatches a remote change; inside an update CodeMirror throws.
      try {
        view.dispatch({ changes: { from: 0, insert: '' } });
      } catch {
        link.flushedInsideUpdate = true;
      }
    };
  };
  const hold = imeHold(view, holdRemote, { ...(options.keyboardSession ? { keyboardSession: true } : {}) });
  view.dispatch({ effects: StateEffect.appendConfig.of(hold.extension) });
  const fire = (type: string) => view.contentDOM.dispatchEvent(new Event(type));
  /** What CodeMirror dispatches once it has read the committed text. */
  const commitRead = () => view.dispatch({ changes: { from: 5, insert: '协同' }, userEvent: 'input.type.compose' });
  return { view, hold, link, fire, commitRead, editContext };
}

describe('IME hold on the editor binding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { __guguIme?: unknown }).__guguIme = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('holds through the composition, and lets go on the tick after CodeMirror has read the commit', () => {
    const { link, fire, commitRead } = setup();
    fire('compositionstart');
    expect(link.depth).toBe(1);
    vi.advanceTimersByTime(2_000);
    fire('compositionupdate');
    vi.advanceTimersByTime(2_000);
    fire('compositionend');
    expect(link.depth).toBe(1);
    commitRead();
    expect(link.depth).toBe(1);
    vi.advanceTimersByTime(0);
    expect(link).toMatchObject({ depth: 0, flushes: 1, flushedInsideUpdate: false });
  });

  it('a transaction read during the composition does not let go', () => {
    const { link, fire, commitRead } = setup();
    fire('compositionstart');
    commitRead();
    vi.advanceTimersByTime(10);
    expect(link.depth).toBe(1);
  });

  it('an input CodeMirror never reads is let go after the read window', () => {
    const { link, fire } = setup();
    fire('beforeinput');
    expect(link.depth).toBe(1);
    vi.advanceTimersByTime(140);
    expect(link.depth).toBe(1);
    vi.advanceTimersByTime(20);
    expect(link.depth).toBe(0);
  });

  it('a composition that stops updating is let go after 3 s (its end may have been lost)', () => {
    const { link, fire } = setup();
    fire('compositionstart');
    vi.advanceTimersByTime(2_900);
    expect(link.depth).toBe(1);
    vi.advanceTimersByTime(200);
    expect(link.depth).toBe(0);
    expect((globalThis as { __guguIme?: { stalled: number } }).__guguIme?.stalled).toBe(1);
  });

  it('a long composition renews its hold without ever letting the file go in between', () => {
    const { link, fire } = setup();
    fire('compositionstart');
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(1_000);
      fire('compositionupdate');
      expect(link.depth).toBeGreaterThan(0);
    }
    expect(link.acquired).toBeGreaterThan(1);
    expect(link.flushes).toBe(0);
  });

  it('blur and a hidden page let everything go', () => {
    const { link, fire } = setup();
    fire('compositionstart');
    fire('blur');
    expect(link.depth).toBe(0);
    fire('compositionstart');
    window.dispatchEvent(new Event('pagehide'));
    expect(link.depth).toBe(0);
  });

  it('off for a control run: nothing is held', () => {
    (globalThis as { __guguIme?: unknown }).__guguIme = { off: true, holds: 0, stalled: 0, maxHoldMs: 0 };
    const { link, fire } = setup();
    fire('compositionstart');
    fire('beforeinput');
    expect(link.acquired).toBe(0);
  });

  describe('the soft-keyboard session (phone, L1 方案 B)', () => {
    const height = (h: number) => {
      Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
      window.dispatchEvent(new Event('resize'));
    };
    const focused = (view: EditorView, on: boolean) => Object.defineProperty(view, 'hasFocus', { value: on, configurable: true });
    beforeEach(() => height(800));

    it('holds while the focused editor has the page squeezed by the keyboard, however long, and merges when it goes down', () => {
      const { view, link } = setup({ keyboardSession: true });
      focused(view, true);
      height(420);
      expect(link.depth).toBe(1);
      for (let i = 0; i < 20; i++) {
        vi.advanceTimersByTime(1_000);
        expect(link.depth).toBeGreaterThan(0);
      }
      expect(link.flushes).toBe(0);
      height(800);
      expect(link.depth).toBe(0);
      expect(link.flushes).toBe(1);
    });

    it('blur ends the session', () => {
      const { view, link, fire } = setup({ keyboardSession: true });
      focused(view, true);
      height(420);
      expect(link.depth).toBe(1);
      fire('blur');
      expect(link.depth).toBe(0);
    });

    it('control: on the desktop (no keyboard session) the same squeeze holds nothing', () => {
      const { view, link } = setup();
      focused(view, true);
      height(420);
      expect(link.acquired).toBe(0);
    });

    it('EditContext path (WebView 133+): the keyboard session holds nothing; a composition holds as on the desktop', () => {
      const { view, link, commitRead, editContext } = setup({ keyboardSession: true, editContext: true });
      focused(view, true);
      height(420);
      vi.advanceTimersByTime(5_000);
      // Control for this cell: the same squeeze on the DOM path is held (the first cell of this block).
      expect(link.acquired).toBe(0);
      editContext!.dispatchEvent(new Event('compositionstart'));
      expect(link.depth).toBe(1);
      editContext!.dispatchEvent(new Event('compositionend'));
      commitRead();
      vi.advanceTimersByTime(0);
      // Let go once the commit was read, with the keyboard still up: others' changes merge while typing goes on.
      expect(link).toMatchObject({ depth: 0, flushes: 1 });
      vi.advanceTimersByTime(5_000);
      expect(link.acquired).toBe(1);
    });

    it('DOM path (WebView 113, no EditContext): the whole keyboard session is still held (方案 B)', () => {
      const { view, link, commitRead, fire } = setup({ keyboardSession: true });
      focused(view, true);
      height(420);
      fire('compositionstart');
      fire('compositionend');
      commitRead();
      vi.advanceTimersByTime(3_000);
      expect(link.depth).toBeGreaterThan(0);
      expect(link.flushes).toBe(0);
    });

    it('control: a squeeze with the editor not focused (another field has the keyboard) holds nothing', () => {
      const { view, link } = setup({ keyboardSession: true });
      focused(view, false);
      height(420);
      expect(link.acquired).toBe(0);
    });

    describe('the same-line pin (EditContext path, L1 角度三)', () => {
      const pinned = () => {
        const s = setup({ keyboardSession: true, editContext: true });
        focused(s.view, true);
        height(420);
        s.hold.pin();
        return s;
      };

      it('holds, however long, until the next composition has ended and been read', () => {
        const { link, commitRead, editContext } = pinned();
        expect(link.depth).toBe(1);
        vi.advanceTimersByTime(10_000);
        expect(link.depth).toBeGreaterThan(0);
        expect(link.flushes).toBe(0);
        editContext!.dispatchEvent(new Event('compositionstart'));
        editContext!.dispatchEvent(new Event('compositionend'));
        expect(link.depth).toBe(1);
        commitRead();
        vi.advanceTimersByTime(0);
        expect(link).toMatchObject({ depth: 0, flushes: 1, flushedInsideUpdate: false });
        expect((globalThis as { __guguIme?: { pins: number } }).__guguIme?.pins).toBe(1);
      });

      it('an input read between compositions does not let it go (control: unpinned, the same input lets go)', () => {
        const { link, fire, commitRead } = pinned();
        fire('beforeinput');
        commitRead();
        vi.advanceTimersByTime(200);
        expect(link.depth).toBe(1);

        const control = setup({ keyboardSession: true, editContext: true });
        focused(control.view, true);
        control.fire('beforeinput');
        control.commitRead();
        vi.advanceTimersByTime(0);
        expect(control.link).toMatchObject({ depth: 0, flushes: 1 });
      });

      it('the keyboard going down lets it go', () => {
        const { link } = pinned();
        vi.advanceTimersByTime(3_000);
        height(800);
        expect(link).toMatchObject({ depth: 0, flushes: 1 });
      });

      it('blur lets it go', () => {
        const { link, fire } = pinned();
        fire('blur');
        expect(link).toMatchObject({ depth: 0, flushes: 1 });
      });

      it('control: with the keyboard down there is nothing to protect — no pin', () => {
        const { view, link, hold } = setup({ keyboardSession: true, editContext: true });
        focused(view, true);
        hold.pin();
        expect(link.acquired).toBe(0);
      });

      it('control: off for a control run pins nothing', () => {
        (globalThis as { __guguIme?: unknown }).__guguIme = { off: true, holds: 0, stalled: 0, maxHoldMs: 0 };
        const { view, link, hold } = setup({ keyboardSession: true, editContext: true });
        focused(view, true);
        height(420);
        hold.pin();
        expect(link.acquired).toBe(0);
      });
    });
  });

  it('unbinding lets go and stops listening', () => {
    const { link, fire, hold } = setup();
    fire('compositionstart');
    hold.destroy();
    expect(link.depth).toBe(0);
    fire('compositionstart');
    expect(link.acquired).toBe(1);
  });
});
