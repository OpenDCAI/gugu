import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import * as Y from 'yjs';

/**
 * Hold the open file's incoming frames while this person composes with an input method, and for
 * the moment after any input until CodeMirror has read it (L1, 真源 §4).
 *
 * Why: on Chrome Android a commit (compositionend, Backspace, Enter) is read into the editor
 * state a frame later. A remote transaction in between makes CodeMirror drop the pending DOM
 * change and redraw the line from the old state, so the chosen word goes back to pinyin.
 * Held at the open file's entrance — before the provider and the replica — the remote change looks
 * like a slower network to Yjs, so merging stays exact and the editor never disagrees with it.
 *
 * The switch is flipped by the editor's own events, synchronously: the window it guards is
 * 2–5 ms, too short for anything that crosses a process. Outgoing frames are never held.
 */

/** Upper bound of the read window after an input; normally released as soon as CodeMirror has read it. */
const READ_WINDOW_MS = 150;
/** A composition that stopped updating: its end event may have been lost. */
const STALLED_COMPOSITION_MS = 3_000;
/** A long composition renews its hold before the link's own guard (5 s) lets go. */
const RENEW_AFTER_MS = 4_000;

/**
 * Diagnostics on the page: `__guguIme.off = true` turns the hold off for a control run (it
 * applies from the next input on); the counters show whether it engaged.
 */
interface ImeHoldDiagnostics {
  off: boolean;
  holds: number;
  stalled: number;
  sessions: number;
  /** Holds started by an update on the caret's line before the caret (`sameLineHold`). */
  pins: number;
  maxHoldMs: number;
}

function diagnostics(): ImeHoldDiagnostics {
  const scope = globalThis as { __guguIme?: ImeHoldDiagnostics };
  scope.__guguIme ??= { off: false, holds: 0, stalled: 0, sessions: 0, pins: 0, maxHoldMs: 0 };
  scope.__guguIme.sessions ??= 0;
  scope.__guguIme.pins ??= 0;
  return scope.__guguIme;
}

export interface ImeHold {
  /** Goes in the binding's compartment: releases early once CodeMirror has read the input. */
  readonly extension: Extension;
  /** CodeMirror edits through an EditContext here (Chrome Android): the patched window, no keyboard-session hold. */
  readonly editContext: boolean;
  /**
   * Hold from now until the next composition has ended and been read, or the editor loses focus, or
   * the keyboard goes down — for an update that lands on the caret's line before the caret
   * (`sameLineHold`). Called from inside `SyncLink.inspect`, so that update is the first one held.
   */
  pin(): void;
  /** The file moved to a new epoch: move a live hold over to the new open file. */
  swapped(): void;
  destroy(): void;
}

/**
 * On the phone the remote change that breaks an input method is not only the one racing a
 * commit: one landing before the caret mid-session makes Android's IME restart its composition
 * (L1 方案 B, 真源 §4 — 8/8 whole against 1/8 with the composition hold alone). So there, the
 * whole soft-keyboard session is held: the editor focused and the page squeezed below 80% of
 * its tallest (adjustResize — a WebView cannot see the IME itself). A floating or hardware
 * keyboard never squeezes the page; the composition hold still covers those.
 *
 * Only on the DOM input path (WebView 113 and older: no EditContext). Where CodeMirror edits through an
 * EditContext (WebView 133+), the platform's patched `@codemirror/view` starts the context window at the
 * caret's line, so a remote change on an earlier line no longer shifts what the IME sees (L1 角度一: 22/35
 * broken without it, 0/32 with it) — the hold there is the composition hold, as on the desktop. Which path is
 * read from the editor itself (`contentDOM.editContext`), never from a version number.
 */
const KEYBOARD_SHARE = 0.8;
/** How often a held keyboard session renews its hold (below the link's own 5 s guard). */
const SESSION_TICK_MS = 1_000;

export function imeHold(view: EditorView, holdRemote: () => () => void, options: { keyboardSession?: boolean } = {}): ImeHold {
  const diag = diagnostics();
  const dom = view.contentDOM;
  // EditContext path (Chrome Android): input and composition go to the EditContext, not the DOM.
  const editContext = (dom as HTMLElement & { editContext?: EventTarget | null }).editContext ?? null;
  const keyboardSession = options.keyboardSession === true && editContext === null;
  const now = () => Date.now();
  let composing = false;
  let lastComposition = 0;
  let readUntil = 0;
  let session = false;
  /** Held since an update landed on the caret's line before the caret; ends with the next composition. */
  let pinned = false;
  let tallest = window.innerHeight;
  let release: (() => void) | null = null;
  let heldSince = 0;
  let renewedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const letGo = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!release) return;
    const done = release;
    release = null;
    diag.maxHoldMs = Math.max(diag.maxHoldMs, Math.round(now() - heldSince));
    done();
  };

  /** A long hold takes a fresh one before letting the old go: the open file is never let through between. */
  const renew = () => {
    if (!release || now() - renewedAt <= RENEW_AFTER_MS) return;
    const previous = release;
    release = holdRemote();
    renewedAt = now();
    previous();
  };

  const check = () => {
    timer = undefined;
    if (!release) return;
    if (composing && now() - lastComposition >= STALLED_COMPOSITION_MS) {
      composing = false;
      diag.stalled += 1;
    }
    if (session || pinned || composing || now() < readUntil) {
      renew();
      schedule();
    } else {
      letGo();
    }
  };

  function schedule() {
    clearTimeout(timer);
    const due = session || pinned ? now() + SESSION_TICK_MS : composing ? lastComposition + STALLED_COMPOSITION_MS : readUntil;
    timer = setTimeout(check, Math.max(0, due - now()) + 1);
  }

  const engage = () => {
    if (diag.off) return;
    if (!release) {
      release = holdRemote();
      heldSince = renewedAt = now();
      diag.holds += 1;
    } else {
      renew();
    }
    schedule();
  };

  const compositionStarted = () => {
    composing = true;
    lastComposition = now();
    engage();
  };
  const compositionUpdated = () => {
    composing = true;
    lastComposition = now();
    engage();
  };
  const compositionEnded = () => {
    composing = false;
    // A pinned hold ends with the composition it waited through: what it held lands once the commit is read.
    pinned = false;
    openReadWindow();
  };
  function openReadWindow() {
    readUntil = Math.max(readUntil, now() + READ_WINDOW_MS);
    engage();
  }
  const textUpdated = () => {
    if (composing) lastComposition = now();
    openReadWindow();
  };
  const letEverythingGo = () => {
    composing = false;
    session = false;
    pinned = false;
    readUntil = 0;
    letGo();
  };
  const hidden = () => {
    if (document.visibilityState === 'hidden') letEverythingGo();
  };
  /** Keyboard up or down (phone only): the session starts or ends; ending it merges at once. */
  const viewportChanged = () => {
    tallest = Math.max(tallest, window.innerHeight);
    const up = view.hasFocus && window.innerHeight < tallest * KEYBOARD_SHARE;
    if (up === session) return;
    session = up;
    if (up) {
      diag.sessions += 1;
      engage();
    } else if (release) {
      check();
    }
  };

  /** Keyboard down while pinned (the page grew back): nothing is typing into the held line any more. */
  const pinnedViewport = () => {
    tallest = Math.max(tallest, window.innerHeight);
    if (!pinned || window.innerHeight < tallest * KEYBOARD_SHARE) return;
    pinned = false;
    if (release) check();
  };
  const pin = () => {
    if (diag.off) return;
    // Only while the soft keyboard is up (the page squeezed): with it down there is no composition to
    // protect, and nothing would come to end the pin. A floating or hardware keyboard never squeezes the
    // page — there the composition hold alone applies, as before.
    tallest = Math.max(tallest, window.innerHeight);
    if (window.innerHeight >= tallest * KEYBOARD_SHARE) return;
    pinned = true;
    diag.pins += 1;
    engage();
  };

  // Bubble phase, after CodeMirror's own handlers on the same element: the arrangement L1 measured.
  const domListeners: [string, () => void][] = [
    ['compositionstart', compositionStarted],
    ['compositionupdate', compositionUpdated],
    ['compositionend', compositionEnded],
    ['beforeinput', openReadWindow],
    ['blur', letEverythingGo],
  ];
  if (keyboardSession) domListeners.push(['focus', viewportChanged]);
  for (const [type, listener] of domListeners) dom.addEventListener(type, listener);
  const contextListeners: [string, () => void][] = [
    ['compositionstart', compositionStarted],
    ['compositionend', compositionEnded],
    ['textupdate', textUpdated],
  ];
  if (editContext) for (const [type, listener] of contextListeners) editContext.addEventListener(type, listener);
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', letEverythingGo);
  if (keyboardSession) {
    window.addEventListener('resize', viewportChanged);
    window.visualViewport?.addEventListener('resize', viewportChanged);
  }
  if (editContext) {
    window.addEventListener('resize', pinnedViewport);
    window.visualViewport?.addEventListener('resize', pinnedViewport);
  }

  const extension = EditorView.updateListener.of((update) => {
    if (!release || composing || session || pinned) return;
    if (update.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))) {
      readUntil = 0;
      // Releasing delivers the held frames, which dispatches; never inside an update.
      clearTimeout(timer);
      timer = setTimeout(check, 0);
    }
  });

  return {
    extension,
    editContext: editContext !== null,
    pin,
    swapped() {
      if (!release) return;
      const previous = release;
      release = holdRemote();
      heldSince = renewedAt = now();
      previous();
    },
    destroy() {
      for (const [type, listener] of domListeners) dom.removeEventListener(type, listener);
      if (editContext) for (const [type, listener] of contextListeners) editContext.removeEventListener(type, listener);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', letEverythingGo);
      if (keyboardSession) {
        window.removeEventListener('resize', viewportChanged);
        window.visualViewport?.removeEventListener('resize', viewportChanged);
      }
      if (editContext) {
        window.removeEventListener('resize', pinnedViewport);
        window.visualViewport?.removeEventListener('resize', pinnedViewport);
      }
      letEverythingGo();
    },
  };
}

/**
 * EditContext path: hold a remote update only when it lands on the caret's line before the caret
 * (L1 角度三). With the patched window, changes on other lines never reach the IME; one on the caret's
 * own line before the caret still shifts its offsets and can end its composition (4/9 runs with a
 * collaborator typing at the start of that line). Everything else stays live.
 *
 * Each incoming update is first applied to a shadow of the replica (the replica plus whatever is held),
 * and its delta is checked against [start of the caret's line, caret] there — both resolved from the
 * editor through relative positions, so updates already held are accounted for. A hit pins the hold
 * (`ImeHold.pin`): that update and all after it wait, in order, for the next composition to end.
 *
 * What it costs (measured, WebView 133): a remote change on the caret's line shows once the word being typed is
 * committed — p50 0.6–0.8 s against 0.3 s — while every other line stays as live as before. Each open editor keeps one
 * shadow Y.Doc, and every update of the file, local and remote, is applied to it once more. A floating or hardware
 * keyboard does not squeeze the page, so the pin cannot tell the keyboard is up and never engages: there it behaves as
 * without it.
 *
 * A pin holds presence too (`HELD_FRAME_TYPES` has Awareness): others' carets stand still until it ends. On purpose —
 * a remote caret redrawn on the caret's line is a dispatch there as well, mid-composition.
 */
export function sameLineHold(
  view: EditorView,
  text: Y.Text,
  inspectRemote: (inspector: (update: Uint8Array) => void) => () => void,
  hold: ImeHold,
): () => void {
  if (!hold.editContext) return () => {};
  const replica = text.doc;
  if (!replica) return () => {};
  const shadow = new Y.Doc();
  Y.applyUpdate(shadow, Y.encodeStateAsUpdate(replica));
  // The same type in the shadow. A top-level text by its name — through a position it would resolve to the untyped
  // placeholder a doc keeps for a root it was never asked for by name; a field of a JSON file (`f.textAt(path)`, a
  // Y.Text nested in a map) through a relative position, its class carried in the update.
  const rootName = [...replica.share.entries()].find(([, type]) => (type as unknown) === text)?.[0];
  const shadowText =
    rootName !== undefined
      ? shadow.getText(rootName)
      : (Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0), shadow)?.type as Y.Text | undefined);
  if (!shadowText) {
    shadow.destroy();
    return () => {};
  }
  // The replica's own changes (local typing, released updates) reach the shadow too; applying one twice is a no-op.
  const follow = (update: Uint8Array) => Y.applyUpdate(shadow, update);
  replica.on('update', follow);
  const inShadow = (index: number) =>
    Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromTypeIndex(text, index), shadow)?.index;

  const stop = inspectRemote((update) => {
    if (!view.hasFocus) {
      Y.applyUpdate(shadow, update);
      return;
    }
    const head = view.state.selection.main.head;
    const from = inShadow(view.state.doc.lineAt(head).from);
    const to = inShadow(head);
    let hit = false;
    const observe = (event: Y.YTextEvent) => {
      if (from === undefined || to === undefined) return;
      let at = 0;
      for (const op of event.delta) {
        if (op.retain !== undefined) at += op.retain;
        else if (op.insert !== undefined) hit ||= at >= from && at <= to;
        else if (op.delete !== undefined) {
          hit ||= at <= to && at + op.delete >= from;
          at += op.delete;
        }
      }
    };
    shadowText.observe(observe);
    Y.applyUpdate(shadow, update);
    shadowText.unobserve(observe);
    if (hit) hold.pin();
  });
  return () => {
    stop();
    replica.off('update', follow);
    shadow.destroy();
  };
}

/**
 * When the soft keyboard shrinks the page and the editor has focus, bring the caret back into
 * view. WebView 133 leaves it under the keyboard (L1 T2 on Android 16); the visual viewport
 * also reports a plain window resize, where this is harmless.
 */
export function keepCaretAboveKeyboard(view: EditorView): () => void {
  const viewport = window.visualViewport;
  const target: EventTarget = viewport ?? window;
  const height = () => viewport?.height ?? window.innerHeight;
  let last = height();
  const resized = () => {
    const current = height();
    const shrank = current < last;
    last = current;
    if (shrank && view.hasFocus) {
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'nearest', yMargin: 24 }) });
    }
  };
  target.addEventListener('resize', resized);
  return () => target.removeEventListener('resize', resized);
}
