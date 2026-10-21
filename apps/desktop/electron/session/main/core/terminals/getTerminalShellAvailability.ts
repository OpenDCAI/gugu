import { getLocalTerminalShellAvailability } from '@main/core/terminal-shell/resolver';

export async function getTerminalShellAvailability() {
  return await getLocalTerminalShellAvailability();
}
