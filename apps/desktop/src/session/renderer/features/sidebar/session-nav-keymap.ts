import type { Hotkey } from '@tanstack/react-hotkeys';
import { matchesKeyboardEvent } from '@tanstack/react-hotkeys';
import type { ShortcutSettingsKey } from '@shared/shortcuts';

/**
 * behavior session-page「键盘导航」 — the key → action decision, kept as a pure function so the whole
 * rule set is testable without a DOM. The listener that uses it stays dumb.
 */

export const SESSION_NAV_SHORTCUT_KEYS = [
  'sessionNext',
  'sessionPrev',
  'sessionFocusComposer',
  'sessionNewInProject',
  'sessionBackToList',
  'sessionLeaveComposer',
  'renameSession',
  'pinSession',
  'archiveHighlightedSession',
] as const satisfies readonly ShortcutSettingsKey[];

export type SessionNavShortcutKey = (typeof SESSION_NAV_SHORTCUT_KEYS)[number];

export type SessionNavHotkeys = Partial<Record<SessionNavShortcutKey, Hotkey | null>>;

/**
 * Where the keyboard currently is.
 *
 * behavior session-page「键盘导航」: inside a composer a key belongs to the composer unless it has
 * nothing to do there. ↑↓ always have something to do — they walk this session's own sent prompts —
 * so they never switch sessions, however empty the box looks. Emptiness is therefore NOT the gate;
 * it only decides whether ⌃X is an archive or the platform's cut.
 */
export type SessionNavContext =
  | 'nav'
  | 'composer-empty'
  /** Includes IME pre-edit: the value looks empty while the user is picking candidates. */
  | 'composer-text';

/** Actions allowed per context. */
const ALLOWED: Record<SessionNavContext, readonly SessionNavShortcutKey[]> = {
  // Everything except the composer exit: in the nav layer ← is already the parent jump, and the two
  // share a default binding on purpose (disjoint layers, see behavior). Listed rather than derived
  // so which of the two wins is a decision in the table, not a consequence of declaration order.
  nav: [
    'sessionNext',
    'sessionPrev',
    'sessionFocusComposer',
    'sessionNewInProject',
    'sessionLeaveComposer',
    'renameSession',
    'pinSession',
    'archiveHighlightedSession',
  ],
  // The composer is already focused, so "focus the composer" has nothing to do here. Bare arrows
  // remain prompt-history keys, while the registered modified arrows explicitly switch sessions.
  'composer-empty': [
    'sessionNext',
    'sessionPrev',
    'sessionBackToList',
    'sessionLeaveComposer',
    'renameSession',
    'pinSession',
    'archiveHighlightedSession',
  ],
  // With text in the box ⌃X is the platform's cut. Rename and pin act on "the session you are in",
  // which is unambiguous while typing — so they stay available. The registered modified arrows
  // likewise switch sessions; the owner explicitly accepts replacing macOS document-boundary movement.
  'composer-text': [
    'sessionNext',
    'sessionPrev',
    'sessionBackToList',
    'sessionLeaveComposer',
    'renameSession',
    'pinSession',
  ],
};

/**
 * Whether `event.defaultPrevented` should be read as "someone else owns this key".
 *
 * It normally is: the mention/slash popup claims ↑↓ by returning true from the suggestion plugin,
 * and ProseMirror calls preventDefault for it. But prosemirror-view's own captureKeyDown prevents
 * Escape (and Enter) on *every* keystroke, handled or not — measured on the real editor, alongside
 * the arrows, which it leaves alone. So inside a composer that flag says nothing about Escape, and
 * honouring it leaves Escape dead in every composer: the one key that has to work there. Nothing is
 * lost by claiming it — the popup explicitly declines Escape (combobox-popup returns false).
 */
export function deferToDefaultPrevented(key: string, context: SessionNavContext): boolean {
  // Outside a composer ProseMirror is not the one preventing, so the flag keeps its meaning.
  if (context === 'nav') return true;
  return key !== 'Escape';
}

export type SessionNavKeyEvent = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'
>;

export interface SessionNavLookupOptions {
  platform?: 'mac' | 'windows' | 'linux';
  /**
   * Whether the composer's caret sits at the very start with nothing selected — the one position
   * where ← would not move anything, which is what makes it free to take as the exit. Anywhere
   * else ← is the caret's and must fall through.
   *
   * A callback, not a value: measuring it walks the document, and it is only consulted for the
   * one key that needs it — computing it eagerly would put that walk on the typing hot path.
   */
  caretAtStart?: () => boolean;
}

/**
 * Extra conditions a key must meet beyond matching its chord — "this key is idle here, so taking
 * it costs nothing". Kept as a table so adding the next idle-gated key is a row, not another `if`
 * buried in the matcher.
 */
const PRECONDITIONS: Partial<
  Record<SessionNavShortcutKey, (options: SessionNavLookupOptions) => boolean>
> = {
  sessionBackToList: ({ caretAtStart }) => caretAtStart?.() === true,
};

/**
 * Whether this keydown, arriving from inside a terminal, is the "leave for the session list" chord.
 *
 * behavior session-page「键盘导航」. Separate from `sessionNavShortcutFor` because the terminal is the
 * one surface with no contexts to weigh: there is exactly one key it gives back, and it gives it
 * back unconditionally. What makes that safe is the chord, not a judgement about the TUI's state —
 * the host cannot see that grid, so any such judgement would be a guess.
 */
export function isTerminalExitChord(
  event: SessionNavKeyEvent,
  hotkey: Hotkey | null,
  options: { platform?: 'mac' | 'windows' | 'linux'; modalOpen?: boolean } = {}
): boolean {
  // null = cleared in settings, which means "off", not "fall back to a default".
  if (!hotkey) return false;
  // A modal owns the keyboard, including over a terminal rendered inside it (agent sign-in).
  if (options.modalOpen === true) return false;
  // Mid-composition the keydown belongs to the IME, whatever chord it looks like.
  if (event.isComposing) return false;
  return matchesKeyboardEvent(event as KeyboardEvent, hotkey, options.platform);
}

export function sessionNavShortcutFor(
  event: SessionNavKeyEvent,
  context: SessionNavContext,
  hotkeys: SessionNavHotkeys,
  options: SessionNavLookupOptions = {}
): SessionNavShortcutKey | null {
  const { platform } = options;
  // Candidate selection in an IME is exactly ↑↓ over a box the app cannot see, and while composing
  // the composer's value is still empty — trusting emptiness alone would steal those keys.
  if (event.isComposing) return null;

  for (const key of ALLOWED[context]) {
    // Chord first, precondition second: the precondition may be expensive to measure.
    const hotkey = hotkeys[key];
    // null = the user cleared this binding in settings, which means "off", not "fall back".
    if (!hotkey) continue;
    if (!matchesKeyboardEvent(event as KeyboardEvent, hotkey, platform)) continue;
    if (PRECONDITIONS[key]?.(options) === false) continue;
    return key;
  }
  return null;
}
