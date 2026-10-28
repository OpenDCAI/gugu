import { describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@gugu/session-core/exec';
import { resolveSessionRuntimeCompatible, type SessionBundleDescriptor } from '@gugu/session-core/agents/plugins';
import { HostDependencyManager, parseHarnessRuntimeVersion } from '@gugu/session-core/deps/runtime';
import type { DependencyDescriptor } from '@gugu/session-core/deps/runtime/types';
import { pluginRegistry } from '../registry';

/**
 * 一个包装器(wcc)先打自己的 banner,再 exec 真的 CLI:输出里两个版本号,第一行也不是它的。原来启动闸读成
 * banner 里的 1.2.74(低于 claude 的地板,判「太旧」),资源库把 banner 整行当成版本。现在每一家声明
 * `hostDependency.versionLine`(它自己那一行长什么样),三处读版本都经 `versionLineOf` 认那一行。
 * 下面每一家的输出是 2026-10-28 Linux 2 上 npm 装真包跑 `--version` 的原样(hermes 用 mac1 10-07 的原样)。
 */
const BANNER = 'wcc: independent env -> /tmp/wcc-env\n启动中：网络通过座位转发 1.2.74\n';
const MEASURED: Array<{ id: string; output: string; gate: string; library: string }> = [
  { id: 'claude', output: '2.1.212 (Claude Code)', gate: '2.1.212', library: '2.1.212' },
  { id: 'codex', output: 'codex-cli 0.145.0', gate: '0.145.0', library: '0.145.0' },
  { id: 'copilot', output: "GitHub Copilot CLI 1.0.105.\nRun 'copilot update' to check for updates.", gate: '1.0.105', library: '1.0.105' },
  {
    id: 'hermes',
    output: 'Hermes Agent v0.21.0 (2026.8.31) · upstream 88704223 · local ab9866bc (+1 carried commit)\nInstall method: git\nPython: 3.11.16\nOpenAI SDK: 2.24.0',
    gate: '0.21.0', library: '0.21.0',
  },
  { id: 'zero', output: 'zero 0.10.0', gate: '0.10.0', library: '0.10.0' },
  { id: 'auggie', output: '0.36.0 (commit 7c61e5bb)', gate: '0.36.0', library: '0.36.0' },
  { id: 'amp', output: '0.0.1793203246-g5eab6d (released 2026-10-28T16:00:46.000Z, 2h ago)', gate: '0.0.1793203246-g5eab6d', library: '0.0.1793203246' },
  ...([
    ['cline', '3.0.74'], ['codebuddy', '2.178.0'], ['commandcode', '1.88.1'], ['continue', '1.5.47'], ['gemini', '0.66.0'], ['kilocode', '7.8.18'],
    ['kimi', '2.4.0'], ['mimocode', '0.1.16'], ['opencode', '1.19.5'], ['pi', '1.4.0'], ['qoder', '1.1.80'], ['qwen', '0.26.3'],
  ] as const).map(([id, version]) => ({ id, output: version, gate: version, library: version })),
];

const BIN = '/opt/wrapped/harness';

function context(output: string, exitCode = 0, stderr = ''): IExecutionContext {
  return {
    root: undefined,
    supportsLocalSpawn: false,
    exec: vi.fn().mockImplementation(async (command: string, args: string[] = []) => {
      if (command === 'which') return { stdout: `${BIN}\n`, stderr: '' };
      if (command === 'realpath') return { stdout: `${args[0]}\n`, stderr: '' };
      if (command === BIN) {
        if (exitCode !== 0) throw Object.assign(new Error('exit'), { code: exitCode, stdout: output, stderr: '' });
        return { stdout: output, stderr };
      }
      throw new Error(`missing ${command}`);
    }),
    refreshShellEnv: undefined,
    execStreaming: vi.fn(),
    dispose: vi.fn(),
  } as unknown as IExecutionContext;
}

const gateDescriptor = {
  surfaces: ['acp'],
  sessionpage: { 'acp': { identity: 'addressable', messageTransport: 'router' } },
  runtimeCompatibility: { 'acp': { kind: 'semver-supported-floor', supportedFloor: '0.0.1', versionArgs: ['--version'] } },
  extension: { kind: 'none' },
} as unknown as SessionBundleDescriptor;

let probes = 0;
async function gateReads(id: string, output: string, versionLine: RegExp | undefined): Promise<string | null> {
  const resolution = await resolveSessionRuntimeCompatible({
    providerId: id, surface: 'acp', descriptor: gateDescriptor, executable: `${BIN}-${probes++}`, versionLine,
    executionContext: { ...context(output), exec: async () => ({ stdout: output, stderr: '' }) } as unknown as IExecutionContext,
  });
  return resolution.harnessVersion ?? null;
}

async function libraryReads(id: string, output: string, versionLine: RegExp | undefined, exitCode = 0, stderr = '') {
  const descriptor: DependencyDescriptor = {
    id, name: id, category: 'agent', commands: ['harness'], versionArgs: ['--version'], ...(versionLine ? { versionLine } : {}),
    installCommands: {}, updates: { kind: 'none' },
  } as DependencyDescriptor;
  const manager = new HostDependencyManager(context(output, exitCode, stderr), { dependencies: [descriptor], platform: 'linux' });
  const state = await manager.probe(id);
  return { version: state.version, status: state.status };
}

describe('the version is read off the harness\'s own line, a wrapper\'s banner before it', () => {
  for (const harness of MEASURED) {
    it(`${harness.id}: both the start gate and the App library read ${harness.gate}`, async () => {
      const versionLine = pluginRegistry.get(harness.id)!.capabilities.hostDependency.versionLine;
      expect(versionLine, `${harness.id} declares its version line`).toBeInstanceOf(RegExp);
      expect(await gateReads(harness.id, BANNER + harness.output, versionLine)).toBe(harness.gate);
      expect(await libraryReads(harness.id, BANNER + harness.output, versionLine)).toEqual({ version: harness.library, status: 'available' });
      // The session-start diagnostic record reads the line it reads without the banner.
      const diagnosed = (stdout: string) => parseHarnessRuntimeVersion({ path: BIN, stdout, stderr: '', exitCode: 0, timedOut: false } as never, versionLine);
      expect(diagnosed(BANNER + harness.output)).toBe(diagnosed(harness.output));
      // [positive control] its plain output reads the same.
      expect(await gateReads(harness.id, harness.output, versionLine)).toBe(harness.gate);
    });
  }

  it('a banner first line with no version and a non-zero exit: still read as running (the own line reported a version)', async () => {
    const versionLine = pluginRegistry.get('claude')!.capabilities.hostDependency.versionLine;
    expect((await libraryReads('claude', BANNER + '2.1.212 (Claude Code)', versionLine, 1)).status).toBe('available');
  });

  it('more than one line looks like its own (the wrapper says "(Claude Code)" too): no line is picked, the old reading stands', async () => {
    const versionLine = pluginRegistry.get('claude')!.capabilities.hostDependency.versionLine;
    const twice = 'wcc 1.2.74 (Claude Code)\n2.1.212 (Claude Code)';
    expect(await gateReads('claude', twice, versionLine)).toBe(await gateReads('claude', twice, undefined));
    expect(await libraryReads('claude', twice, versionLine)).toEqual(await libraryReads('claude', twice, undefined));
  });

  it('a bare version line with trailing spaces or a Windows \\r is still its own', async () => {
    const versionLine = pluginRegistry.get('opencode')!.capabilities.hostDependency.versionLine;
    expect(await gateReads('opencode', `${BANNER.replace(/\n/g, '\r\n')}1.19.5 \r\n`, versionLine)).toBe('1.19.5');
  });

  it('[control] a harness that declares no line reads as before', async () => {
    expect(await gateReads('x', 'codex-cli 0.145.0', undefined)).toBe('0.145.0');
    // …except that a first line with no version is no version: its text is not shown as one.
    expect(await libraryReads('x', 'wcc: banner\ncodex-cli 0.145.0', undefined)).toEqual({ version: null, status: 'available' });
  });

  it('reclaude\'s first probe (only its sync banner, on stderr; Linux 2 10-28 verbatim) reads as no version, not 「同步配置…」', async () => {
    const versionLine = pluginRegistry.get('claude')!.capabilities.hostDependency.versionLine;
    expect(await libraryReads('claude', '', versionLine, 0, '同步配置…\n')).toEqual({ version: null, status: 'available' });
    expect(parseHarnessRuntimeVersion({ path: BIN, stdout: '', stderr: '同步配置…\n', exitCode: 0, timedOut: false } as never, versionLine)).toBeNull();
    // [positive control] once synced it prints its own line on stdout, the banner still on stderr.
    expect(await libraryReads('claude', '2.1.302 (Claude Code)\n', versionLine, 0, '同步配置…\n')).toEqual({ version: '2.1.302', status: 'available' });
  });

  it('declares its line, and a wrapper puts a version on a line that is not it: no version, the first line is not taken', async () => {
    const versionLine = pluginRegistry.get('claude')!.capabilities.hostDependency.versionLine;
    expect(await libraryReads('claude', BANNER, versionLine)).toEqual({ version: null, status: 'available' });
  });
});
