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

/** Terminal widgets and modal roots can stop global entry keys before bubbling. */
function CapturedCommandKey({ id }: { id: CommandId }) {
  const { value: keyboard } = useAppSettingsKey('keyboard');
  const hotkey = getEffectiveHotkey(id, keyboard);
  useEffect(() => {
    if (!hotkey) return;
    const platform = detectPlatform();
    const onCommandKey = (event: KeyboardEvent) => {
      if (event.isComposing || !matchesKeyboardEvent(event, hotkey, platform)) return;
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || (id === 'app.find' && active.closest('.monaco-editor, [cmdk-root], [role=menu]'))) return;
      if (!commandRegistry.dispatch(id)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener('keydown', onCommandKey, true);
    return () => document.removeEventListener('keydown', onCommandKey, true);
  }, [hotkey, id]);
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
  const ids = commandRegistry.shortcutsPaused ? [] : [...new Set(commandRegistry.activeCommands.map((command) => command.id))]
    .filter((id) => COMMANDS[id].conflictBehavior !== 'allow');
  return <>{ids.map((id) => COMMANDS[id].capture ? <CapturedCommandKey key={id} id={id} /> : <CommandKey key={id} id={id} />)}</>;
});
