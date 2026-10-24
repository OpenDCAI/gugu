import { useEffect } from 'react';
import { commandRegistry } from '@renderer/lib/commands/registry';
import { events } from '@renderer/lib/ipc';
import { browserAppShortcutChannel } from '@shared/events/appEvents';

export function BrowserAppShortcutEvents() {
  useEffect(() => events.on(browserAppShortcutChannel, ({ commandId }) => {
    commandRegistry.dispatch(commandId);
  }), []);
  return null;
}
