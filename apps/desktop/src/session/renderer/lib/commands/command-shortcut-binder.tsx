import { detectPlatform, matchesKeyboardEvent, useHotkey } from '@tanstack/react-hotkeys';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { COMMANDS, getEffectiveHotkey, getHotkeyRegistration, type CommandId } from '@renderer/lib/hooks/useKeyboardShortcuts';
import { commandRegistry } from './registry';

function CommandKey({ id }: { id: CommandId }) {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  useHotkey(getHotkeyRegistration(id, keyboard), () => commandRegistry.dispatch(id), {
    enabled: getEffectiveHotkey(id, keyboard) !== null,
    ignoreInputs: COMMANDS[id].ignoreInputs,
  });
  return null;
}

/** xterm consumes Ctrl sequences on Windows/Linux before document bubbling. */
function FindCommandKey() {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey('app.find', keyboard);
  useEffect(() => {
    if (!hotkey) return;
    const platform = detectPlatform();
    const find = (event: KeyboardEvent) => {
      if (event.isComposing || !matchesKeyboardEvent(event, hotkey, platform)) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active.closest('.monaco-editor, [cmdk-root], [role=menu]')) return;
      commandRegistry.setContext(active);
      if (!commandRegistry.dispatch('app.find')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', find, true);
    return () => document.removeEventListener('keydown', find, true);
  }, [hotkey]);
  return null;
}

export const CommandShortcutBinder = observer(function CommandShortcutBinder() {
  useEffect(() => {
    const capture = (event: Event) => {
      if (event.target instanceof HTMLElement) commandRegistry.setContext(event.target);
    };
    document.addEventListener('focusin', capture, true);
    document.addEventListener('pointerdown', capture, true);
    return () => {
      document.removeEventListener('focusin', capture, true);
      document.removeEventListener('pointerdown', capture, true);
    };
  }, []);
  const ids = [...new Set(commandRegistry.activeCommands.map((command) => command.id))]
    .filter((id) => COMMANDS[id].conflictBehavior !== 'allow');
  return <>{ids.map((id) => id === 'app.find' ? <FindCommandKey key={id} /> : <CommandKey key={id} id={id} />)}</>;
});
