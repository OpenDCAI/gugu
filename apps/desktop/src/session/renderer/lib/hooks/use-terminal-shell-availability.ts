import { useQuery } from '@tanstack/react-query';
import { rpc } from '@renderer/lib/ipc';
import type { TerminalShellAvailability } from '@shared/core/terminals/terminal-settings';

export const DEFAULT_TERMINAL_SHELL_AVAILABILITY: TerminalShellAvailability[] = [];

export function useTerminalShellAvailability(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ['terminal-shell-availability'],
    queryFn: () => rpc.terminals.getTerminalShellAvailability(),
    staleTime: 30_000,
    enabled: options.enabled ?? true,
  });
}
