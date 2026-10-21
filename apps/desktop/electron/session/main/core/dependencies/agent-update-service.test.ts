import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('../agents/agent-payload-builder', () => ({ toAgentInstallationStatus: vi.fn() }));
vi.mock('./registry', () => ({ getDependencyDescriptor: vi.fn() }));

import { AgentUpdateService } from './agent-update-service';

const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';

function descriptor(methods: string[]) {
  return {
    id: 'pi',
    name: 'Pi',
    category: 'agent',
    commands: ['pi'],
    installCommands: { [platform]: methods.map((method) => ({ method, command: `${method} install pi` })) },
    updates: { kind: 'supported', update: { kind: 'package-manager' }, releaseSource: { kind: 'npm', package: 'pi' } },
  };
}

/** 用户自己用 Homebrew 装的那份:不归咕咕管(manageable=false)。 */
function ownCopy(version: string) {
  return {
    id: 'brew',
    version,
    manageable: false,
    provenance: { kind: 'brew', ours: false },
  };
}

function enrich(desc: unknown, version: string, latest: string) {
  const svc = new AgentUpdateService() as unknown as {
    applyEnrichment: (d: unknown, h: unknown, l: string) => { installations: Array<{ updateAvailable: boolean; latestVersion: string | null }> };
  };
  return svc.applyEnrichment(desc, { installations: [ownCopy(version)] }, latest).installations[0];
}

describe('AgentUpdateService 的「有新版本」判据', () => {
  it('自己装的那份落后了、咕咕装得了这一家 → 照实报新版本(点「更新」= 咕咕装一份最新的切过去)', () => {
    const inst = enrich(descriptor(['mise']), '0.84.2', '0.87.0');
    expect(inst.updateAvailable).toBe(true);
    expect(inst.latestVersion).toBe('0.87.0');
  });

  it('已经是最新版 → 不报', () => {
    expect(enrich(descriptor(['mise']), '0.87.0', '0.87.0').updateAvailable).toBe(false);
  });

  it('咕咕装不了这一家(没有托管安装)→ 不报:点了没有下一步', () => {
    expect(enrich(descriptor(['brew']), '0.84.2', '0.87.0').updateAvailable).toBe(false);
  });

});
