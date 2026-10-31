import { commandRegistry } from '@renderer/lib/commands/registry';
import { useCommandProvider } from '@renderer/lib/commands/use-command-provider';
import { detectPlatform } from '@tanstack/react-hotkeys';
import { useEffect, useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { getEffectiveHotkey } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { modalStore } from '@renderer/lib/modal/modal-store';
import { setTerminalKeyboardExitHandler } from '@renderer/lib/pty/terminal-keyboard-exit';
import { caretAtStartOf } from './caret-at-start';
import { focusSessionComposer, sessionKeyboardNav } from './session-keyboard-nav';
import {
  deferToDefaultPrevented,
  isTerminalExitChord,
  SESSION_NAV_SHORTCUT_KEYS,
  sessionNavShortcutFor,
  type SessionNavContext,
  type SessionNavHotkeys,
  type SessionNavShortcutKey,
} from './session-nav-keymap';

const PLATFORM = detectPlatform();

/** The ProseMirror element every composer on the session page renders (session, project home, new task). */
const PROMPT_EDITOR_SELECTOR = '[data-testid="prompt-editor"]';
/** Surfaces that own their keyboard outright and must never have a key taken from them. */
const KEY_OWNING_SURFACES = '.xterm, .monaco-editor, .cm-editor, webview, iframe';

function pathElements(event: KeyboardEvent): HTMLElement[] {
  // The session page runs inside an open shadow root in the gugu shell, where `event.target` is
  // retargeted to the host — only composedPath() sees the real element.
  return event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
}

/** The element that really holds focus, looking through open shadow roots (the session page lives in one). */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function focusedElementMatches(selector: string): boolean {
  const active = deepActiveElement();
  return Boolean(active && active !== document.body && active.closest(selector));
}

function closestInPath(event: KeyboardEvent, selector: string): HTMLElement | null {
  for (const element of pathElements(event)) {
    if (element.matches(selector)) return element;
    const found = element.closest(selector);
    if (found instanceof HTMLElement) return found;
  }
  return null;
}

function hasKeyboardOwningOverlay(event: KeyboardEvent): boolean {
  return Boolean(
    closestInPath(
      event,
      '[role="dialog"], [role="menu"], [role="listbox"], [data-slot="popover-content"], [data-slot="popover-popup"], [data-slot="sheet-content"]',
    ),
  );
}

/**
 * A modal dialog open anywhere in the document owns the keyboard, wherever focus happens to be.
 * `hasKeyboardOwningOverlay` only sees the event's own path, and `modalStore` only knows the task
 * page's own modals — the gugu shell's modals (the settings Sheet, the image preview) live outside
 * both. When focus falls to <body> behind such a modal (e.g. a menu inside it closes and its trigger
 * is gone), the path carries no dialog, so a printable key used to count as "nav" and was handed to
 * the composer behind the modal: 2026-09-24 an `ssh …` typed into settings → 设备 started a real
 * session. The shell marks every modal with aria-modal (ui/Sheet, ImagePreviewProvider).
 */
export function hasOpenModalDialog(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/**
 * Which of the three rule sets applies to this event, or null for "not ours".
 *
 * The composer is TipTap, so "empty" is read off the rendered document rather than a value
 * property. IME pre-edit deliberately counts as text: mid-composition the document is still empty
 * but ↑↓ belong to the candidate list.
 */
export function sessionNavContextFor(event: KeyboardEvent): {
  context: SessionNavContext;
  /** The composer the event came from, so the caret probe does not walk composedPath again. */
  editor: HTMLElement | null;
} | null {
  if (modalStore.isOpen || hasOpenModalDialog()) return null;
  if (hasKeyboardOwningOverlay(event)) return null;
  // Terminals, editors and the in-app browser keep every key: ⌃R stays reverse-history-search,
  // ↑ stays "previous command", ← stays the caret. The host cannot tell whether a TUI's prompt
  // line is empty — that grid is drawn by another process — and every approximation we measured
  // (counting keystrokes, comparing cursor columns, diffing the screen) breaks on deleting,
  // pasting, soft-wrapped input or content the TUI fills in itself. Owner 2026-08-10: 有 bug 宁愿
  // 不加。The terminal's way out is `terminalBackToList`, claimed inside xterm's own key handler
  // (see lib/pty/terminal-keyboard-exit) on a chord no TUI we run binds — no state to guess.
  if (closestInPath(event, KEY_OWNING_SURFACES)) return null;
  // An embedded page (extension tab, in-app browser) owns the keyboard while it holds focus, even
  // when a key reaches us: Electron re-dispatches keys the guest did not consume onto the
  // embedder's <body>, so the event path never contains the <webview>. Without this, typing into
  // an extension's text field jumped the caret into the session composer / terminal (#6387,
  // owner 2026-09-24「输不进去啊」). Judged by who holds focus, not by where the event landed.
  if (focusedElementMatches(KEY_OWNING_SURFACES)) return null;

  const editor = closestInPath(event, PROMPT_EDITOR_SELECTOR);
  if (editor) {
    if (event.isComposing) return { context: 'composer-text', editor };
    return { context: editor.textContent?.trim() ? 'composer-text' : 'composer-empty', editor };
  }

  // Any other text field (sidebar search, dialog inputs) keeps its own keys.
  if (closestInPath(event, 'input, textarea, select, [contenteditable="true"], [role="textbox"]')) {
    return null;
  }
  return { context: 'nav', editor: null };
}

/** Keys that only ever accompany another one, so pressing them is not "pressing another key". */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);

/** A key that would produce text: exactly the case where the composer, not the list, should get it. */
function isPrintable(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return [...event.key].length === 1;
}

function runShortcut(key: SessionNavShortcutKey): boolean {
  switch (key) {
    case 'session.next':
      return sessionKeyboardNav.move(1);
    case 'session.previous':
      return sessionKeyboardNav.move(-1);
    case 'session.focusComposerFromSidebar':
      return sessionKeyboardNav.handOffToComposer();
    case 'session.projectHome':
      return sessionKeyboardNav.goToParent();
    case 'session.backToList':
    case 'session.leaveComposer':
      return sessionKeyboardNav.leaveComposer();
    case 'session.rename':
      return commandRegistry.dispatch('session.rename');
    case 'session.pinHighlighted':
      return sessionKeyboardNav.togglePin();
    case 'session.archiveHighlighted':
      return sessionKeyboardNav.pressArchive();
  }
}

/**
 * behavior session-page「键盘导航」. One bubble-phase listener rather than per-composer wiring: by the
 * time the event reaches it, TipTap's suggestion plugin has already claimed ↑↓ if a mention or
 * slash popup is open (ProseMirror calls preventDefault when a plugin handles a key), so
 * `defaultPrevented` is a "someone else owns this key" signal and no popup sniffing or
 * cross-package prop threading is needed — with one measured exception, see
 * `deferToDefaultPrevented`.
 */
export function SessionKeyboardNavListener() {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  useCommandProvider({
    scopeId: 'app',
    getCommands: () => [{
      id: 'session.rename',
      hideFromPalette: sessionKeyboardNav.cursor?.kind !== 'conversation',
      execute: (task) => sessionKeyboardNav.startRename(task ? { kind: 'conversation', ...task } : undefined),
    }],
  });

  const hotkeys = useMemo<SessionNavHotkeys>(() => {
    const map: SessionNavHotkeys = {};
    for (const key of SESSION_NAV_SHORTCUT_KEYS) map[key] = getEffectiveHotkey(key, keyboard);
    return map;
  }, [keyboard]);

  const terminalExitHotkey = getEffectiveHotkey('session.leaveTerminal', keyboard);

  // behavior session-page「键盘导航」: the terminal's one concession. It is installed rather than
  // listened for because a terminal never lets a keydown reach the document — xterm consumes it
  // and encodes it for the PTY — so the only place to claim a key is inside xterm's own handler.
  // null means the user cleared the binding in settings, which is "off": the terminal then keeps
  // every key and ⌘0 is the remaining way back.
  useEffect(() => {
    if (!terminalExitHotkey) return;
    return setTerminalKeyboardExitHandler((event) => {
      if (!isTerminalExitChord(event, terminalExitHotkey, {
        platform: PLATFORM,
        modalOpen: modalStore.isOpen || hasOpenModalDialog(),
      })) {
        return false;
      }
      return sessionKeyboardNav.leaveComposer();
    });
  }, [terminalExitHotkey]);

  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const element = event
        .composedPath()
        .find((node): node is Element => node instanceof Element);
      if (element) sessionKeyboardNav.syncFocusFromElement(element);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const where = sessionNavContextFor(event);
      if (!where) return;
      const { context, editor } = where;
      // TipTap prevents ArrowUp/ArrowDown in an empty editor for its own history handling. The
      // registered Mod+Arrow session bindings are the explicit owner of those modified arrows;
      // overlays have already been filtered above, so only unmodified arrows defer here.
      if (
        event.defaultPrevented &&
        !(event.metaKey || event.ctrlKey) &&
        deferToDefaultPrevented(event.key, context)
      ) {
        return;
      }
      const shortcut = sessionNavShortcutFor(event, context, hotkeys, {
        platform: PLATFORM,
        caretAtStart: () => (editor ? caretAtStartOf(editor) : false),
      });
      // behavior session-page「键盘导航」: an armed archive is cancelled by "按下任何其它键", not only by
      // the few that happen to move the cursor. Held modifiers are excluded — the second ⌃X starts
      // with a Control keydown, which would otherwise disarm the very press meant to confirm.
      if (shortcut !== 'session.archiveHighlighted' && !MODIFIER_KEYS.has(event.key)) {
        sessionKeyboardNav.clearPendingArchive();
      }
      if (!shortcut) {
        // behavior session-page「键盘导航」: typing while the nav layer holds the keyboard jumps back
        // into the composer without eating the character. Focusing during keydown is enough — the
        // resulting text input is delivered to whatever is focused by then — so this deliberately
        // does NOT preventDefault. It also means → is only needed when you want the caret back
        // without typing anything.
        if (context === 'nav' && isPrintable(event)) focusSessionComposer();
        return;
      }
      if (!runShortcut(shortcut)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [hotkeys]);

  return null;
}
