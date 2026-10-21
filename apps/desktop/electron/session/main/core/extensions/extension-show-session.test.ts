import { describe, expect, it, vi } from 'vitest';

/**
 * #7158 `sessionHere`: this computer's session as its task list shows it. The list does not show an archived session
 * (任务历史 does), so neither does `gugu.showSession` — a session page navigated to one lands on a new task (A/B cell 8).
 * The database stand-in really filters by the id (`eq`), so reading the wrong row turns this red.
 */

type Row = Record<string, unknown>;
const rows: Row[] = [
  { id: 's-listed', projectId: 'p-1', archivedAt: null },
  { id: 's-archived', projectId: 'p-1', archivedAt: '2026-10-13 11:09:09' },
];

vi.mock('drizzle-orm', () => ({ eq: (column: { name: string }, value: unknown) => ({ column: column.name, value }) }));
vi.mock('@main/db/schema', () => ({
  sessions: { id: { name: 'id' }, projectId: { name: 'projectId' }, archivedAt: { name: 'archivedAt' } },
}));
vi.mock('@main/db/client', () => ({
  db: {
    select: (shape: Record<string, { name: string }>) => ({
      from: () => ({
        where: (condition: { column: string; value: unknown }) => ({
          limit: async () =>
            rows
              .filter((row) => row[condition.column] === condition.value)
              .map((row) => Object.fromEntries(Object.entries(shape).map(([key, column]) => [key, row[column.name]]))),
        }),
      }),
    }),
  },
}));

const { sessionHere } = await import('./extension-show-session');

describe('sessionHere (#7158): this computer\'s session as the task list shows it', () => {
  it('a listed session: its project; an archived one and an unknown one: none', async () => {
    expect(await sessionHere('s-listed')).toBe('p-1');
    expect(await sessionHere('s-archived')).toBeNull();
    expect(await sessionHere('s-nobody')).toBeNull();
  });
});
