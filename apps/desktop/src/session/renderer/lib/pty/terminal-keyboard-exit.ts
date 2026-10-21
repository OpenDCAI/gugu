/**
 * The one key a terminal gives back to the app: the way out to the session list.
 *
 * behavior session-page「键盘导航」. A terminal owns its keyboard outright — ⌃R stays
 * reverse-history-search, ↑ stays "previous command", ← stays the caret — because the host cannot
 * see what the TUI inside it is doing. That leaves the keyboard with no way *out*, which is the
 * gap this seam closes, and it closes it with a chord that is measurably unclaimed rather than with
 * a guess about the TUI's state.
 *
 * A seam rather than a direct call because the two halves live on opposite sides of the layering:
 * `usePty` is a lib-level hook and must not reach into sidebar features, while the chord itself is
 * a user-rebindable setting only the feature layer reads. The feature installs its handler here;
 * the terminal asks this module first and suppresses xterm when the answer is yes.
 */

/** Returns true when it consumed the event, meaning xterm must not see it. */
export type TerminalKeyboardExitHandler = (event: KeyboardEvent) => boolean;

let handler: TerminalKeyboardExitHandler | null = null;

/** Installs the handler; returns the uninstall function for effect cleanup. */
export function setTerminalKeyboardExitHandler(next: TerminalKeyboardExitHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * Whether this keydown is the "leave the terminal" chord, and if so, acts on it.
 *
 * Null handler means the session page is not mounted (the agent sign-in modal renders a terminal of
 * its own), so nothing is claimed — the terminal keeps every key, which is the safe direction.
 */
export function handleTerminalKeyboardExit(event: KeyboardEvent): boolean {
  return handler?.(event) ?? false;
}
