import { describe, expect, it } from 'vitest';
import { filterRemoteProjectEntries, remoteProjectEntries } from './composer-context-tray';

describe('别的机器上的项目选择器(#6264)', () => {
  const projects = [
    { name: 'web', path: '/srv/web' },
    { name: 'api', path: '/srv/api/' },
    { name: 'docs', path: '/home/bob/docs' },
  ];

  it('最近用过的在前(用那台机器上的项目名),其余按名字;同一路径只出现一次', () => {
    const entries = remoteProjectEntries(projects, ['/srv/api', '/tmp/scratch/']);
    expect(entries).toEqual([
      { path: '/srv/api', name: 'api', recent: true },
      { path: '/tmp/scratch', name: 'scratch', recent: true },
      { path: '/home/bob/docs', name: 'docs', recent: false },
      { path: '/srv/web', name: 'web', recent: false },
    ]);
  });

  it('搜索按名字或路径', () => {
    const entries = remoteProjectEntries(projects, []);
    expect(filterRemoteProjectEntries(entries, 'bob').map((e) => e.name)).toEqual(['docs']);
    expect(filterRemoteProjectEntries(entries, 'WE').map((e) => e.name)).toEqual(['web']);
  });
});
