import type { CommandItem } from '@gugu/session-ui/react/components';

function normalizedQuery(query: string): string {
  return query.trim().toLowerCase();
}

function commandMatchesQuery(command: CommandItem, query: string): boolean {
  if (!query) return true;
  return [command.name, command.label, command.description]
    .filter((value): value is string => !!value)
    .some((value) => value.toLowerCase().includes(query));
}

function matchRank(command: CommandItem, query: string): number {
  const name = command.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;

  const label = command.label?.toLowerCase();
  if (label === query) return 3;
  if (label?.startsWith(query)) return 4;
  if (label?.includes(query)) return 5;

  return 6;
}

/**
 * Return provider commands in match-quality order while preserving provider order for ties.
 * An empty query deliberately keeps the provider's advertised order.
 */
export function filterSlashCommands(commands: readonly CommandItem[], query: string): CommandItem[] {
  const normalized = normalizedQuery(query);
  return commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => commandMatchesQuery(command, normalized))
    .sort((left, right) => {
      if (!normalized) return left.index - right.index;
      return (
        matchRank(left.command, normalized) - matchRank(right.command, normalized) ||
        left.index - right.index
      );
    })
    .map(({ command }) => command);
}
