import { describe, expect, it } from 'vitest';
import { miseDependency } from '../agents/plugins/helpers/host-dependency';
import { hostDependencyDescriptorSchema } from './capability';
import {
  agentProgramFor,
  agentProgramsOf,
  authProgramRole,
  buildDescriptorsFromProvider,
} from './descriptor-from-provider';

const companionDependency = miseDependency({
  id: 'agy',
  backend: 'vendor-manifest',
  manifest: 'https://updater.example/manifests/{platform}.json',
  platforms: { 'darwin-arm64': 'darwin_arm64', 'win32-x64': 'windows_amd64' },
  archiveExecutable: 'antigravity',
});
const hostDependency = hostDependencyDescriptorSchema.parse({
  ...miseDependency({ id: 'agy_acp_server', backend: 'acp-registry', agentId: 'antigravity-acp' }),
  companions: [{ id: 'antigravity-cli', name: 'Antigravity CLI', legs: ['tui'], dependency: companionDependency }],
});
const provider = {
  metadata: { id: 'antigravity', name: 'Antigravity', websiteUrl: 'https://x' },
  capabilities: { hostDependency, sessionBundle: {} },
} as never;
const single = {
  metadata: { id: 'codex', name: 'Codex', websiteUrl: 'https://x' },
  capabilities: {
    hostDependency: miseDependency({ id: 'codex', package: '@openai/codex', executables: { 'darwin-arm64': 'bin/codex' } }),
    sessionBundle: {},
  },
} as never;

describe('一家几个程序(#6335)', () => {
  it('按腿取程序:终端腿 → 伴随程序 agy,聊天腿与 primary → 主程序', () => {
    expect(agentProgramFor(provider, 'tui')).toEqual({ dependencyId: 'antigravity-cli', binaryName: 'agy' });
    expect(agentProgramFor(provider, 'acp')).toEqual({ dependencyId: 'antigravity', binaryName: 'agy_acp_server' });
    expect(agentProgramFor(provider, 'primary')).toEqual({ dependencyId: 'antigravity', binaryName: 'agy_acp_server' });
  });

  it('登录按程序解析角色:伴随程序 → 它认领的腿(拿到的就是它的可执行文件),缺席/认不出 → primary', () => {
    expect(authProgramRole(provider, 'antigravity-cli')).toBe('tui');
    expect(agentProgramFor(provider, authProgramRole(provider, 'antigravity-cli')).dependencyId).toBe('antigravity-cli');
    expect(authProgramRole(provider, undefined)).toBe('primary');
    // 认不出的 id 不在这里换成主程序去登 —— 回 primary,由宿主登录面响亮拒绝
    expect(authProgramRole(provider, 'nope')).toBe('primary');
    expect(authProgramRole(single, 'antigravity-cli')).toBe('primary');
  });

  it('没有伴随程序的家:两条腿都是它自己', () => {
    expect(agentProgramFor(single, 'tui')).toEqual({ dependencyId: 'codex', binaryName: 'codex' });
    expect(agentProgramsOf(single)).toEqual([
      { dependencyId: 'codex', binaryName: 'codex', name: 'Codex', legs: ['tui', 'acp'] },
    ]);
  });

  it('依赖管理器里是两行:伴随程序那一行带 ownerId、自己的装法与更新源', () => {
    const [main, companion] = buildDescriptorsFromProvider(provider);
    expect(main!.id).toBe('antigravity');
    expect(main!.ownerId).toBeUndefined();
    expect(companion!.id).toBe('antigravity-cli');
    expect(companion!.ownerId).toBe('antigravity');
    expect(companion!.commands).toEqual(['agy']);
    expect(companion!.skipVersionProbe).toBeUndefined();
    expect(companion!.updates).toMatchObject({ kind: 'supported', releaseSource: { kind: 'vendor-manifest' } });
    expect(companion!.installCommands?.windows?.[0]?.target).toMatchObject({
      kind: 'mise', binary: 'agy', backend: { kind: 'vendor-manifest', archiveExecutable: 'antigravity' },
    });
    expect(agentProgramsOf(provider).map((part) => [part.dependencyId, part.legs])).toEqual([
      ['antigravity', ['acp']],
      ['antigravity-cli', ['tui']],
    ]);
  });

  it('两个伴随程序认领同一条腿 → schema 拒收', () => {
    const entry = { id: 'a-cli', name: 'A', legs: ['tui'], dependency: companionDependency };
    expect(() => hostDependencyDescriptorSchema.parse({
      ...miseDependency({ id: 'x', backend: 'acp-registry', agentId: 'x' }),
      companions: [entry, { ...entry, id: 'b-cli' }],
    })).toThrow('two companions claim the same leg');
  });

  it('清单 URL 必须 https 且恰好一个 {platform}', () => {
    const bad = (manifest: string) => hostDependencyDescriptorSchema.safeParse(
      miseDependency({ id: 'agy', backend: 'vendor-manifest', manifest, platforms: {}, archiveExecutable: 'a' }),
    ).success;
    expect(bad('https://u.example/{platform}.json')).toBe(true);
    expect(bad('http://u.example/{platform}.json')).toBe(false);
    expect(bad('https://u.example/{platform}/{platform}.json')).toBe(false);
  });
});
