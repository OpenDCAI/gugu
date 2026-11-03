import { describe, expect, it } from 'vitest';
import type { SearchItem } from '@shared/core/search';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { paletteTasks, type ListedPaletteTask } from './palette-tasks';

const local = (id: string, lastInteractedAt?: string | null, title = id): SearchItem => ({
  kind: 'session', id, projectId: 'local-project', title, subtitle: '', score: 0, lastInteractedAt,
});
const remote = (id: string, lastInteractedAt: string | null, patch: Partial<SessionpageSessionSummary> = {}): ListedPaletteTask => ({
  deviceId: 'other-device', deviceLabel: 'Other computer', live: true,
  summary: { conversationId: id, projectId: 'inbound-project', title: id, harness: 'codex',
    runtime: 'acp', agentStatus: null, supported: true, lastInteractedAt, ...patch },
});
const ids = (rows: SearchItem[]) => rows.map(row => row.id);
const at = (minute: number) => new Date(Date.UTC(2026, 10, 2, 6, minute)).toISOString();

describe('command palette tasks across devices', () => {
  it('mixes local and remote tasks by interaction and keeps the local copy of an id', () => {
    const here = local('same', at(1), 'local copy');
    expect(paletteTasks([here, local('local-new', at(3))], [remote('same', at(9)), remote('remote', at(2))], '', null))
      .toEqual([local('local-new', at(3)), expect.objectContaining({ id: 'remote', deviceId: 'other-device' }), here]);
  });

  it('takes the newest ten after combining both devices, without changing inputs', () => {
    const here = Array.from({ length: 4 }, (_, i) => local(`task-${i}`, at(i)));
    const there = Array.from({ length: 10 }, (_, i) => remote(`task-${i + 4}`, at(i + 4)));
    const before = JSON.stringify([here, there]);
    expect(ids(paletteTasks(here, there, '', null)))
      .toEqual(Array.from({ length: 10 }, (_, i) => `task-${13 - i}`));
    expect(JSON.stringify([here, there])).toBe(before);
  });

  it('puts null and missing interaction times after dated tasks', () => {
    expect(ids(paletteTasks([local('missing'), local('dated', at(1))], [remote('null', null)], '', null)))
      .toEqual(['dated', 'missing', 'null']);
  });

  it('uses the shared openability and assistant rules while retaining delegated tasks', () => {
    const rows = [remote('closed', at(5), { supported: false }),
      remote('assistant', at(4), { agent: { userId: 'assistant-id' } }),
      remote('child', at(3), { parentConversationId: 'assistant', agent: { userId: 'child-agent' } }),
      remote('native', at(2), { supported: false, nativeInputVersion: 1 })];
    expect(ids(paletteTasks([], rows, '', 'assistant-id'))).toEqual(['child', 'native']);
  });

  it('keeps raw task titles for search and preserves the inbound project and device', () => {
    expect(paletteTasks([], [remote('task', at(1), { title: 'codex (2)' })], '', null))
      .toEqual([expect.objectContaining({ title: 'codex (2)', projectId: 'inbound-project', deviceId: 'other-device', deviceLabel: 'Other computer' })]);
    expect(paletteTasks([local('here', at(2))], [], '', null)[0]).not.toHaveProperty('deviceId');
  });

  it('matches remote titles, retaining local index hits recalled through other fields', () => {
    const here = [local('branch-hit', at(1), 'unrelated title'), local('another-hit', at(2), 'another title')];
    expect(ids(paletteTasks(here, [remote('matching', at(3), { title: 'needle' }), remote('remote-body-only', at(4))], 'needle', null)))
      .toEqual(['matching', 'branch-hit', 'another-hit']);
  });

  it('ranks nonempty title matches with the shared matcher rather than recency', () => {
    expect(ids(paletteTasks([], [remote('contains', at(9), { title: 'fix needle today' }),
      remote('prefix', at(8), { title: 'needle task' }), remote('exact', at(1), { title: 'needle' })], 'needle', null)))
      .toEqual(['exact', 'prefix', 'contains']);
  });

  it('keeps local title ranking stable when a remote title is added', () => {
    const here = [local('contains', at(4), 'fix alpha today'), local('exact', at(1), 'alpha'), local('prefix', at(2), 'alpha local')];
    expect(ids(paletteTasks(here, [remote('remote', at(3), { title: 'alpha remote' })], 'alpha', null)).filter(id => id !== 'remote'))
      .toEqual(['exact', 'prefix', 'contains']);
  });

  it('shows the initial directory summary with zero local tasks and follows archive updates', () => {
    const listed = { ...remote('summary', at(2)), live: false };
    expect(ids(paletteTasks([], [listed], '', null))).toEqual(['summary']);
    expect(paletteTasks([], [], '', null)).toEqual([]);
  });

  it('excludes projects from tasks and deduplicates repeated remote directory rows', () => {
    expect(ids(paletteTasks([{ ...local('project'), kind: 'project' }], [remote('same', at(2)), remote('same', at(1))], '', null)))
      .toEqual(['same']);
  });
});
