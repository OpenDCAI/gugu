import { describe, expect, it } from 'vitest';
import type { AgentProgramPart } from '@gugu/session-core/deps/runtime';
import type { AgentInstallationStatus, Installation } from '@shared/core/agents/agent-payload';
import { foldAgentPrograms, partsToInstall, partsToUpdate } from './agent-programs';

const parts: AgentProgramPart[] = [
  { dependencyId: 'antigravity', binaryName: 'agy_acp_server', name: 'Antigravity', legs: ['acp'] },
  { dependencyId: 'antigravity-cli', binaryName: 'agy', name: 'Antigravity CLI', legs: ['tui'] },
];

function managedCopy(version: string, updateAvailable = false): Installation {
  return {
    id: 'm', realpath: '/m', pathEntry: '/m', isActive: true, manageable: true,
    provenance: { kind: 'mise', confidence: 'confirmed', ours: true },
    status: 'available', version, latestVersion: null, updateAvailable,
  };
}

function status(id: string, over: Partial<AgentInstallationStatus> = {}): AgentInstallationStatus {
  return {
    id, status: 'available', reading: 'installed', version: '1.0.0', latestVersion: null,
    updateAvailable: false, command: '/bin/x', installations: [], used: { kind: 'auto' }, usedId: 'auto',
    installOptions: [], ...over,
  };
}

describe('foldAgentPrograms —— 一家几个程序时按腿合并读数(#6335)', () => {
  it('终端腿的程序没装:顶层不说「已安装」,但聊天面板那条腿照样是装好的', () => {
    const folded = foldAgentPrograms(parts, (id) =>
      id === 'antigravity' ? status(id, { installations: [managedCopy('1.2.1')] }) : status(id, { status: 'missing', reading: 'not-detected', version: null }),
    )!;
    expect(folded.reading).toBe('not-detected');
    expect(folded.status).toBe('missing');
    expect(folded.legReadings).toEqual({ 'acp': 'installed', 'tui': 'not-detected' });
    expect(folded.programs!.map((p) => [p.dependencyId, p.managed, p.managedVersion])).toEqual([
      ['antigravity', true, '1.2.1'],
      ['antigravity-cli', false, null],
    ]);
    // 来源列表那几格仍是主程序的。
    expect(folded.id).toBe('antigravity');
    expect(folded.installations).toHaveLength(1);
  });

  it('伴随程序那一行还没探过 → 按「一份都没有」算,❌ 不把「还没看过」报成装好了', () => {
    const folded = foldAgentPrograms(parts, (id) => (id === 'antigravity' ? status(id) : undefined))!;
    expect(folded.legReadings?.['tui']).toBe('not-detected');
    expect(folded.reading).toBe('not-detected');
  });

  it('跑不起来压过选中那份没了;两个都好才是 installed', () => {
    expect(foldAgentPrograms(parts, (id) =>
      id === 'antigravity' ? status(id, { reading: 'missing' }) : status(id, { reading: 'detected-but-broken', status: 'error' }),
    )!.reading).toBe('detected-but-broken');
    expect(foldAgentPrograms(parts, (id) => status(id))!.reading).toBe('installed');
  });

  it('只有伴随程序那一份有新版本,这一家也报有更新', () => {
    const folded = foldAgentPrograms(parts, (id) =>
      id === 'antigravity' ? status(id) : status(id, { installations: [managedCopy('1.2.9', true)] }),
    )!;
    expect(folded.updateAvailable).toBe(true);
    expect(folded.programs![1]!.managedUpdateAvailable).toBe(true);
  });

  it('只有一个程序的家原样返回,不多挂 programs / legReadings', () => {
    const single = status('codex');
    expect(foldAgentPrograms([parts[0]!], () => single)).toBe(single);
  });
});

describe('一次点击动哪几个程序(#6335)', () => {
  it('安装:只补咕咕还没有自己那一份的程序;全有了才全装;单程序的家恒是它自己', () => {
    expect(partsToInstall(parts, (id) => id === 'antigravity').map((p) => p.dependencyId)).toEqual(['antigravity-cli']);
    expect(partsToInstall(parts, () => false).map((p) => p.dependencyId)).toEqual(['antigravity', 'antigravity-cli']);
    expect(partsToInstall(parts, () => true).map((p) => p.dependencyId)).toEqual(['antigravity', 'antigravity-cli']);
    expect(partsToInstall([parts[0]!], () => true)).toEqual([parts[0]]);
  });

  it('更新:只动有新版本的那几个;一个都没标出来时退回主程序', () => {
    const flagged = [
      { dependencyId: 'antigravity', managedUpdateAvailable: false },
      { dependencyId: 'antigravity-cli', managedUpdateAvailable: true },
    ];
    expect(partsToUpdate(parts, flagged).map((p) => p.dependencyId)).toEqual(['antigravity-cli']);
    expect(partsToUpdate(parts, undefined).map((p) => p.dependencyId)).toEqual(['antigravity']);
  });
});
