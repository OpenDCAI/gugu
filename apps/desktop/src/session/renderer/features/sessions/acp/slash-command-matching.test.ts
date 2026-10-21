import { describe, expect, it } from 'vitest';
import type { CommandItem } from '@gugu/session-ui/react/components';
import { filterSlashCommands } from './slash-command-matching';

function command(name: string, description?: string): CommandItem {
  return {
    id: name,
    name,
    ...(description ? { description } : {}),
    behavior: 'insert',
  };
}

describe('slash command matching', () => {
  it('puts the strongest match first instead of reversing match quality', () => {
    const commands = [
      command('review-branch', 'Review the current branch'),
      command('review'),
      command('summarize', 'Review and summarize the current thread'),
    ];

    expect(filterSlashCommands(commands, 'review').map((item) => item.name)).toEqual([
      'review',
      'review-branch',
      'summarize',
    ]);
  });

  it('keeps provider order for an empty query and equal match ranks', () => {
    const commands = [command('review-alpha'), command('review-beta')];

    expect(filterSlashCommands(commands, '').map((item) => item.name)).toEqual([
      'review-alpha',
      'review-beta',
    ]);
    expect(filterSlashCommands(commands, 'review').map((item) => item.name)).toEqual([
      'review-alpha',
      'review-beta',
    ]);
  });
});
