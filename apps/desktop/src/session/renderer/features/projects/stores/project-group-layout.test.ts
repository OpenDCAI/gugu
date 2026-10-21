// #7341 第二步:绑在同一个项目群上的本地项目(各台机器上的)在侧栏合成一行。
import { describe, expect, it } from 'vitest';
import { EMPTY_MACHINE_HOME_LAYOUT, type MachineHomeLayout } from '@renderer/features/remote-hosts/machine-home';
import { foldProjectGroups, projectGroupLayout } from './project-group-layout';

const chats: Record<string, string> = { 'local-gugu': 'chat-gugu', 'd22-gugu': 'chat-gugu', 'd15-gugu': 'chat-gugu', 'local-memor': 'chat-memor' };
const chatIdOf = (id: string) => chats[id];

describe('projectGroupLayout', () => {
  it('folds every machine’s copy of a project into the one on this computer', () => {
    const layout = projectGroupLayout(
      [
        { id: 'd22-gugu', machine: 'd22' },
        { id: 'local-gugu', machine: null },
        { id: 'd15-gugu', machine: 'd15' },
        { id: 'local-memor', machine: null },
        { id: 'unbound', machine: null },
      ],
      chatIdOf
    );
    expect(layout.members.get('local-gugu')).toEqual(['local-gugu', 'd15-gugu', 'd22-gugu']);
    expect(layout.folded.get('local-gugu')).toEqual(['d15-gugu', 'd22-gugu']);
    expect(layout.rowOf.get('d22-gugu')).toBe('local-gugu');
    // 只有一台上有的项目(memor)、没绑群的项目:不折叠,各自一行。
    expect(layout.members.has('local-memor')).toBe(false);
    expect(layout.rowOf.has('unbound')).toBe(false);
  });

  it('without a copy on this computer, picks the same representative every time', () => {
    const projects = [
      { id: 'd22-gugu', machine: 'd22' },
      { id: 'd15-gugu', machine: 'd15' },
    ];
    const once = projectGroupLayout(projects, chatIdOf);
    const again = projectGroupLayout([...projects].reverse(), chatIdOf);
    expect(once.members.get('d15-gugu')).toEqual(['d15-gugu', 'd22-gugu']);
    expect(again.members.get('d15-gugu')).toEqual(['d15-gugu', 'd22-gugu']);
  });

  it('keeps the chosen target as the row when two projects on this computer join one group', () => {
    const projects = [
      { id: 'a-source', machine: null, representative: false },
      { id: 'z-target', machine: null, representative: true },
    ];
    const layout = projectGroupLayout(projects, () => 'chat-shared');
    expect(layout.members.get('z-target')).toEqual(['z-target', 'a-source']);
    expect(layout.rowOf.get('a-source')).toBe('z-target');
  });
});

describe('foldProjectGroups', () => {
  const groups = projectGroupLayout(
    [
      { id: 'local-gugu', machine: null },
      { id: 'd22-gugu', machine: 'd22' },
      { id: 'd22-home', machine: 'd22' },
    ],
    (id) => (id === 'd22-home' ? 'chat-gugu' : chatIdOf(id))
  );

  it('adds the group folds on top of the machine-home folds', () => {
    const base: MachineHomeLayout = {
      ...EMPTY_MACHINE_HOME_LAYOUT,
      homeRows: new Set(['d22-root']),
      folded: new Map([['d22-root', ['d22-taskhome']]]),
      rowOf: new Map([['d22-taskhome', 'd22-root']]),
    };
    const merged = foldProjectGroups(base, projectGroupLayout(
      [
        { id: 'local-gugu', machine: null },
        { id: 'd22-gugu', machine: 'd22' },
      ],
      chatIdOf
    ));
    expect(merged.folded.get('d22-root')).toEqual(['d22-taskhome']);
    expect(merged.folded.get('local-gugu')).toEqual(['d22-gugu']);
    expect(merged.rowOf.get('d22-gugu')).toBe('local-gugu');
    expect(merged.rowOf.get('d22-taskhome')).toBe('d22-root');
  });

  it('leaves a project that is already a machine-home row out of the group fold', () => {
    const base: MachineHomeLayout = { ...EMPTY_MACHINE_HOME_LAYOUT, homeRows: new Set(['d22-home']) };
    const merged = foldProjectGroups(base, groups);
    expect(merged.folded.get('local-gugu')).toEqual(['d22-gugu']);
    expect(merged.rowOf.has('d22-home')).toBe(false);
  });

  it('is the identity when nothing is shared', () => {
    const base = EMPTY_MACHINE_HOME_LAYOUT;
    expect(foldProjectGroups(base, projectGroupLayout([{ id: 'a', machine: null }], () => undefined))).toBe(base);
  });
});
