import { detectPlatform, normalizeHotkey } from '@tanstack/hotkeys';
import { useEffect, useMemo } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import {
  COMMANDS,
  getEffectiveHotkey,
  type CommandId,
} from '@renderer/lib/hooks/useKeyboardShortcuts';
import { dispatchMatchingHotkeys } from '@renderer/lib/hotkeys/dispatch-matching-hotkeys';

function isCodeEditorFocused(event: KeyboardEvent): boolean {
  return event.composedPath().some(node => node instanceof HTMLElement && node.closest('.cm-editor'));
}

/**
 * Intercepts keyboard events at capture phase and fires matching TanStack hotkey
 * registrations when a code editor has focus.
 *
 * CodeMirror handles (and stops) the keys its keymaps bind, so they never reach
 * TanStack's document-level listeners (bubbling phase). This bridge uses capture
 * phase, which runs before the editor's handlers, so it cannot be blocked by them.
 *
 * When no code editor is focused the handler returns immediately and normal TanStack
 * bubbling-phase handling takes over unchanged.
 */
export function CodeEditorKeyboardBridge() {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const ignoredHotkeys = useMemo(() => {
    const platform = detectPlatform();
    const next = new Set<string>();
    const shortcuts = Object.entries(COMMANDS) as [
      CommandId,
      (typeof COMMANDS)[CommandId],
    ][];

    for (const [key, def] of shortcuts) {
      if (!def.ignoreWhenCodeEditorFocused) continue;
      const hotkey = getEffectiveHotkey(key, keyboard);
      if (hotkey !== null) next.add(normalizeHotkey(hotkey, platform));
    }

    return next;
  }, [keyboard]);

  useEffect(() => {
    const platform = detectPlatform();

    const handler = (e: KeyboardEvent) => {
      if (!isCodeEditorFocused(e)) return;

      const handled = dispatchMatchingHotkeys(e, {
        filter: (registration) =>
          !ignoredHotkeys.has(normalizeHotkey(registration.hotkey, platform)),
      });

      // Prevent the event from reaching the editor and skip the TanStack bubbling
      // listener (which would otherwise double-dispatch the same shortcut).
      if (handled) e.stopPropagation();
    };

    document.addEventListener('keydown', handler, { capture: true });
    return () => document.removeEventListener('keydown', handler, { capture: true });
  }, [ignoredHotkeys]);

  return null;
}
