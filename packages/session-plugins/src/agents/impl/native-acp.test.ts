import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '../registry';

const spawnCtx = {
  cwd: '/home/user/worktrees/task-1',
  env: {},
  cli: '/usr/local/bin/agent',
};

const nativeAcpProviders: Array<{
  id: string;
  cli?: string;
  args: string[];
  command?: string;
  env?: Record<string, string>;
}> = [
  {
    id: 'auggie',
    args: ['--acp'],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  // #6335:托管装好的 `agy_acp_server` 就是 ctx.cli,不带参数;回环免代理无条件带上
  // (它起会话要连自己的本地 harness,被系统代理截走时 session/new -32603)。
  {
    id: 'antigravity',
    args: [],
    env: { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  },
  { id: 'cline', args: ['--acp'] },
  { id: 'copilot', args: ['--acp'] },
  { id: 'cursor', args: ['acp'] },
  { id: 'devin', args: ['acp'] },
  // gemini 的 `--skip-trust` 是 MCP 投递的硬前置(未信任目录下 session/new 的 mcpServers
  // 被静默忽略,实测 0.57.0,#4655) —— 掉了这个 flag 不报错,只是咕咕的工具悄悄一个都不到。
  { id: 'gemini', args: ['--acp', '--skip-trust'] },
  {
    id: 'droid',
    args: ['exec', '--output-format', 'acp-daemon'],
    env: {
      DROID_DISABLE_AUTO_UPDATE: 'true',
      FACTORY_DROID_AUTO_UPDATE_ENABLED: 'false',
    },
  },
  { id: 'grok', args: ['agent', 'stdio'] },
  { id: 'junie', args: ['--acp=true'] },
  { id: 'kilocode', args: ['acp'] },
  { id: 'kimi', args: ['acp'] },
  { id: 'kiro', args: ['acp'] },
  { id: 'mimocode', args: ['acp', '--print-logs', '--log-level', 'ERROR'] },
  { id: 'oh-my-pi', args: ['acp'] },
  {
    id: 'mistral',
    cli: '/usr/local/bin/vibe',
    command: '/usr/local/bin/vibe-acp',
    args: [],
  },
  {
    id: 'mistral',
    cli: 'vibe.cmd',
    command: 'vibe-acp.cmd',
    args: [],
  },
  { id: 'qoder', args: ['--acp'] },
  { id: 'qwen', args: ['--acp', '--experimental-skills'] },
];

describe('native ACP provider behaviors', () => {
  it.each(nativeAcpProviders)('$id declares ACP support', ({ id }) => {
    const provider = pluginRegistry.get(id);

    expect(provider).toBeDefined();
    expect(provider!.capabilities.acp.kind).toBe('supported');
    expect(provider!.behavior.acp).toBeDefined();
  });

  it.each(nativeAcpProviders)('$id starts the documented native ACP command', (entry) => {
    const provider = pluginRegistry.get(entry.id)!;
    const cli = entry.cli ?? spawnCtx.cli;
    const spawn = provider.behavior.acp!.buildSpawn({ ...spawnCtx, cli });

    expect(spawn.command).toBe(entry.command ?? cli);
    expect(spawn.args).toEqual(entry.args);

    if (entry.env) {
      expect(spawn.env).toEqual(entry.env);
    }
  });

  // #6218 —— copilot 的 ACP 进程就是 copilot 本体,物化器的 argv(起始推理档)只能挂在它上面。
  it('copilot hands the session materializer argv to the ACP process', () => {
    const spawn = pluginRegistry.get('copilot')!.behavior.acp!.buildSpawn({
      ...spawnCtx,
      capabilityArgs: ['--effort', 'low'],
    });
    expect(spawn.args).toEqual(['--acp', '--effort', 'low']);
  });
});
