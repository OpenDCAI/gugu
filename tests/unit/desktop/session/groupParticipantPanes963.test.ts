import { describe, expect, it } from 'vitest';
import { ScreenLayoutStore, type ScreenBlockContent } from '@renderer/app/screen-layout';
import { GroupParticipantPanes } from '@renderer/features/chats/group-participant-panes';

const source = { kind: 'chat', chatId: 'group' } as const;
const agent = (sessionId: string): ScreenBlockContent => ({ kind: 'session', projectId: 'project', sessionId });
const setup = () => {
  const screen = new ScreenLayoutStore();
  screen.show(source);
  return { screen, panes: new GroupParticipantPanes(screen) };
};

describe('one participant workspace beside its source group', () => {
  it('switches A → B → A without adding siblings or changing workspace identities', () => {
    const { screen, panes } = setup();
    for (const id of ['a', 'b', 'a']) {
      expect(panes.show('group', source, agent(id))).toBe(true);
      expect(screen.order.map(key => screen.blocks.get(key))).toEqual([source, agent(id)]);
    }
    const before = screen.snapshot;
    panes.show('group', source, agent('a'));
    expect(screen.snapshot).toEqual(before);
    expect(panes.joinedGroups(screen.joinedGroups)).toEqual([]);
  });

  it('hides the auxiliary view without forgetting the session, so independent entry reuses it', () => {
    const { screen, panes } = setup();
    panes.show('group', source, agent('a'));
    panes.hide('group');
    expect([...screen.blocks.values()]).toEqual([source]);
    screen.show(agent('a'));
    expect(screen.sessions.map(one => one.sessionId)).toEqual(['a']);
    expect(panes.placements.size).toBe(0);
  });

  it('leaves the current group intact if a late lookup finishes after navigation away', () => {
    const { screen, panes } = setup();
    screen.show({ kind: 'chat', chatId: 'other' });
    expect(panes.show('group', source, agent('late'))).toBe(false);
    expect([...screen.blocks.values()]).toEqual([{ kind: 'chat', chatId: 'other' }]);
  });

  it('shares the remembered right width across participants and retains it on reload', () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    const { screen } = setup();
    const panes = new GroupParticipantPanes(screen, storage);
    panes.rememberWidth(600);
    panes.show('group', source, agent('a'), 1000);
    expect(screen.layout?.type === 'split' && screen.layout.sizes).toEqual([40, 60]);
    panes.show('group', source, agent('b'), 1000);
    expect(screen.layout?.type === 'split' && screen.layout.sizes).toEqual([40, 60]);
    const restored = new GroupParticipantPanes(screen, storage);
    expect(restored.rightWidth).toBe(600);
    expect(restored.ownerOf(screen.blockOf(agent('b'))!)).toBe('group');
  });

  it('supports an existing human DM and a project group without creating any conversation', () => {
    const screen = new ScreenLayoutStore();
    const project = { kind: 'project', projectId: 'project-group' } as const;
    screen.show(project);
    const panes = new GroupParticipantPanes(screen);
    const dm = { kind: 'chat', chatId: 'existing-dm' } as const;
    expect(panes.show('project-chat', project, dm)).toBe(true);
    expect(screen.order.map(key => screen.blocks.get(key))).toEqual([project, dm]);
  });

  it('clamps a narrow window without overwriting the width wanted on reopening', () => {
    const { screen, panes } = setup();
    panes.rememberWidth(600);
    panes.show('group', source, agent('a'), 500);
    expect(screen.layout?.type).toBe('split');
    if (screen.layout?.type === 'split') {
      expect(screen.layout.sizes[0] * 500 / 100).toBeCloseTo(220);
      expect(screen.layout.sizes[1] * 500 / 100).toBeCloseTo(280);
    }
    expect(panes.rightWidth).toBe(600);
    panes.hide('group');
    panes.show('group', source, agent('a'), 1000);
    expect(screen.layout?.type === 'split' && screen.layout.sizes).toEqual([40, 60]);
  });
});

it('transfers a participant between two visible groups without leaving the old group as its owner', () => {
  const { screen, panes } = setup();
  panes.show('group', source, agent('a'));
  const other = { kind: 'chat', chatId: 'second-group' } as const;
  screen.showBeside(other);
  panes.show('second-group', other, agent('a'));
  expect(panes.ownerOf(screen.blockOf(agent('a'))!)).toBe('second-group');
  expect(panes.placements.has('group')).toBe(false);
  panes.hide('group');
  expect(screen.blockOf(agent('a'))).toBeDefined();
});

it('does not hide a participant independently rearranged away from its source', () => {
  const { screen, panes } = setup();
  panes.show('group', source, agent('a'));
  screen.placeAt(agent('a'), screen.blockOf(source)!, 'bottom');
  expect(panes.ownerOf(screen.blockOf(agent('a'))!)).toBeUndefined();
  panes.hide('group');
  expect(screen.blockOf(agent('a'))).toBeDefined();
});

it('keeps saved placement and width separate across accounts', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const { screen } = setup();
  const panes = new GroupParticipantPanes(screen, storage);
  panes.useAccount('first');
  panes.rememberWidth(600);
  panes.show('group', source, agent('a'));
  panes.useAccount('second');
  expect(panes.placements.size).toBe(0);
  expect(panes.rightWidth).toBe(480);
  panes.rememberWidth(400);
  panes.useAccount('first');
  expect(panes.rightWidth).toBe(600);
  expect(panes.placements.get('group')?.target).toEqual(agent('a'));
  panes.useAccount(null);
  expect(panes.placements.size).toBe(0);
});
