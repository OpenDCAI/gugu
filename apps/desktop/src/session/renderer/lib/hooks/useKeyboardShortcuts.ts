import type { Hotkey } from '@tanstack/react-hotkeys';
import { COMMANDS, type CommandId } from '@shared/commands';
import { resolveDefaultHotkey } from '@shared/shortcuts';

export type { CommandDef, CommandId } from '@shared/commands';
export { COMMANDS } from '@shared/commands';
export { resolveDefaultHotkey, sharesChordIntentionally } from '@shared/shortcuts';

type ShortcutOverrides = Partial<Record<CommandId, string | null>>;

/**
 * Returns the currently assigned hotkey for an action.
 * - `undefined` override -> falls back to default
 * - `null` override -> unassigned (disabled)
 * - no `defaultHotkey` and no override -> `null` (not bound)
 */
export function getEffectiveHotkey(
  key: CommandId,
  custom?: ShortcutOverrides
): Hotkey | null {
  const configured = custom?.[key];
  if (configured === null) return null;
  const resolved = configured ?? resolveDefaultHotkey(COMMANDS[key]);
  return resolved != null ? (resolved as Hotkey) : null;
}

/**
 * Always returns a valid hotkey string for hook registration.
 * Pair this with `getEffectiveHotkey(...) !== null` in `enabled`.
 */
export function getHotkeyRegistration(
  key: CommandId,
  custom?: ShortcutOverrides
): Hotkey {
  return (getEffectiveHotkey(key, custom) ??
    resolveDefaultHotkey(COMMANDS[key]) ??
    '') as Hotkey;
}
