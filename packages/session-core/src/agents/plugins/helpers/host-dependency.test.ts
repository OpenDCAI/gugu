import { describe, expect, it } from 'vitest';
import { hostDependencyDescriptorSchema } from '../../../host-dependencies/capability';
import { miseDependency } from './host-dependency';

describe('miseDependency — ACP 注册表形态(#6335)', () => {
  const descriptor = miseDependency({
    id: 'agy_acp_server',
    backend: 'acp-registry',
    agentId: 'antigravity-acp',
    installDocs: 'https://antigravity.google/docs/ide/extensions',
  });

  it('过得了 capability schema —— package 填 agent id,正则照旧成立', () => {
    expect(() => hostDependencyDescriptorSchema.parse(descriptor)).not.toThrow();
  });

  it('三个平台各一个选项,指向 http backend,❌ 不带 npm 下载源', () => {
    for (const platform of ['macos', 'windows', 'linux'] as const) {
      const options = descriptor.installCommands[platform]!;
      expect(options).toHaveLength(1);
      expect(options[0]).toMatchObject({
        method: 'mise',
        command: 'mise install http:gugu-agy_acp_server',
        recommended: true,
        target: {
          kind: 'mise',
          package: 'antigravity-acp',
          binary: 'agy_acp_server',
          backend: { kind: 'acp-registry', agentId: 'antigravity-acp' },
        },
      });
      expect(options[0]!.registry).toBeUndefined();
      expect(options[0]!.registryPackage).toBeUndefined();
    }
  });

  it('最新版本读注册表;版本探测不执行它', () => {
    expect(descriptor.updates).toEqual({
      kind: 'supported',
      releaseSource: { kind: 'acp-registry', agentId: 'antigravity-acp' },
      update: { kind: 'package-manager' },
    });
    expect(descriptor.skipVersionProbe).toBe(true);
    expect(descriptor.binaryNames).toEqual(['agy_acp_server']);
    expect(descriptor.installDocs).toBe('https://antigravity.google/docs/ide/extensions');
  });
});
