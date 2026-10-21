import { describe, expect, it } from 'vitest';
import { findHomeProject, machineHomeLayout, type MachineHomeLookup } from './machine-home';

const SESSION_HOME = 'task-home~d22';

function lookup(machines: Record<string, string>, homes: Record<string, string>): MachineHomeLookup {
  return {
    machineOf: (id) => machines[id] ?? null,
    homeDir: (deviceId) => homes[deviceId] ?? null,
    isSessionHome: (id) => id.startsWith('task-home'),
  };
}

describe('别的机器的主目录项目(#6264 behavior gugu-server:别的机器上的会话一律属于那台机器上的某个项目)', () => {
  it('已有同路径的项目就是主目录项目(末尾斜杠不算差别)', () => {
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }, { id: 'h', path: '/home/alice/' }], '/home/alice')?.id).toBe('h');
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }], '/home/alice')).toBeNull();
    expect(findHomeProject([{ id: 'a', path: '/srv/app' }], null)).toBeNull();
  });

  it('那台机器的任务工作区并进它的主目录项目那一行显示,❌ 单列、❌ 进「任务」', () => {
    const layout = machineHomeLayout(
      [
        { id: 'home-d22', path: '/root' },
        { id: 'app-d22', path: '/root/app' },
        { id: SESSION_HOME, path: '/root/.config/咕咕/task-home' },
      ],
      lookup({ 'home-d22': 'd22', 'app-d22': 'd22', [SESSION_HOME]: 'd22' }, { d22: '/root' })
    );
    expect([...layout.homeRows]).toEqual(['home-d22']);
    expect(layout.folded.get('home-d22')).toEqual([SESSION_HOME]);
    expect(layout.rowOf.get(SESSION_HOME)).toBe('home-d22');
    expect(layout.standIns.size).toBe(0);
  });

  it('那台机器还没有主目录项目:任务工作区代位成「~」那一行(读取时归属,不建、不挪)', () => {
    const layout = machineHomeLayout(
      [{ id: SESSION_HOME, path: '/root/.config/咕咕/task-home' }],
      lookup({ [SESSION_HOME]: 'd22' }, { d22: '/root' })
    );
    expect([...layout.homeRows]).toEqual([SESSION_HOME]);
    expect(layout.standIns.get(SESSION_HOME)).toBe('d22');
    expect(layout.rowOf.size).toBe(0);
  });

  it('#7199 个人助理住的那台:上面的项目全并进一行(按它归组),❌ 一个项目一组;对照:别的机器照旧只并任务工作区', () => {
    const projects = [
      { id: 'home-cloud', path: '/home/wuying' },
      { id: 'proj-cloud', path: '/home/wuying/云电脑' },
      { id: 'task-home~cloud', path: '/home/wuying/.config/咕咕/task-home' },
      { id: 'home-d22', path: '/root' },
      { id: 'app-d22', path: '/root/app' },
    ];
    const machines = { 'home-cloud': 'cloud', 'proj-cloud': 'cloud', 'task-home~cloud': 'cloud', 'home-d22': 'd22', 'app-d22': 'd22' };
    const layout = machineHomeLayout(projects, {
      ...lookup(machines, { cloud: '/home/wuying', d22: '/root' }),
      foldAll: (deviceId) => deviceId === 'cloud',
    });
    expect([...layout.homeRows].sort()).toEqual(['home-cloud', 'home-d22']);
    expect(layout.folded.get('home-cloud')).toEqual(['task-home~cloud', 'proj-cloud']);
    expect(layout.rowOf.get('proj-cloud')).toBe('home-cloud');
    expect(layout.rowOf.has('app-d22')).toBe(false);
  });

  it('#7199 个人助理那台还没问到主目录:任务工作区代位那一行,其余项目并进去', () => {
    const layout = machineHomeLayout(
      [
        { id: 'proj-cloud', path: '/home/wuying/云电脑' },
        { id: 'task-home~cloud', path: '/x/task-home' },
      ],
      { ...lookup({ 'proj-cloud': 'cloud', 'task-home~cloud': 'cloud' }, {}), foldAll: () => true }
    );
    expect([...layout.homeRows]).toEqual(['task-home~cloud']);
    expect(layout.standIns.get('task-home~cloud')).toBe('cloud');
    expect(layout.rowOf.get('proj-cloud')).toBe('task-home~cloud');
  });

  it('本机不变:本机的项目与本机的任务工作区都不参与', () => {
    const layout = machineHomeLayout(
      [
        { id: 'task-home', path: '/Users/me/task-home' },
        { id: 'mine', path: '/Users/me' },
      ],
      lookup({}, {})
    );
    expect(layout.homeRows.size).toBe(0);
    expect(layout.standIns.size).toBe(0);
  });
});
