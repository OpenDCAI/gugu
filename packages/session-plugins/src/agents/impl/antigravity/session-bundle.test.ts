import { describe, expect, it } from 'vitest';
import type { SessionCapabilityBundle } from '@gugu/session-core/agents/plugins';
import { pluginRegistry } from '../../registry';
import {
  ANTIGRAVITY_SESSION_TUI_ENABLED,
  antigravitySessionBundleDescriptor,
  materializeAntigravitySessionBundle,
  withLoopbackNoProxy,
} from './session-bundle';

const ctx = { surface: 'acp' as const, lifecycle: 'fresh' as const, cwd: '/work' };

function bundle(overrides: Partial<SessionCapabilityBundle> = {}): SessionCapabilityBundle {
  return {
    mcpServers: [],
    env: { GUGU_HOME: '/gugu' },
    model: null,
    autonomy: null,
    promptBlocks: { platform: 'P-BLOCK ', identity: 'I-BLOCK' },
    packages: [],
    ...overrides,
  };
}

describe('antigravity session bundle (agy_acp_server 1.1.1, #6335)', () => {
  it('两条腿(Windows 只剩协议腿);mcp 按腿、promptBlocks 终端腿走 PreInvocation 钩子的 ephemeral 消息、model / autonomy 如实 none', () => {
    expect(antigravitySessionBundleDescriptor.surfaces).toEqual(
      ANTIGRAVITY_SESSION_TUI_ENABLED ? ['acp', 'tui'] : ['acp']
    );
    const units = antigravitySessionBundleDescriptor.units;
    expect(units.mcp).toEqual({
      kind: 'per-surface',
      surfaces: {
        'acp': { kind: 'native', channel: 'acp-session' },
        'tui': { kind: 'native', channel: 'config-file', transports: ['http'] },
      },
    });
    expect(units.env).toEqual({ kind: 'native', channel: 'child-process' });
    expect(units.promptBlocks.surfaces['acp']).toEqual({ kind: 'native', channel: 'session-context' });
    expect(units.promptBlocks.surfaces['tui']).toEqual({ kind: 'native', channel: 'hook-ephemeral' });
    expect(units.model.kind).toBe('none');
    expect(units.autonomy.kind).toBe('none');
    expect(antigravitySessionBundleDescriptor.selfUpdate).toMatchObject({
      kind: 'session-env',
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    });
  });

  it('http MCP 的凭据只进 Authorization 头,不留在子进程环境里;stdio 的 env 只递引用', () => {
    const result = materializeAntigravitySessionBundle(
      ctx,
      bundle({
        env: { GUGU_HOME: '/gugu', GUGU_MCP_TOKEN: 'Bearer tok-1', GUGU_STDIO_TOKEN: 'tok-2' },
        mcpServers: [
          { name: 'gugu', transport: 'http', url: 'http://127.0.0.1:1/mcp', authorizationEnv: 'GUGU_MCP_TOKEN' },
          { name: 'side', transport: 'stdio', command: 'node', args: ['s.mjs'], env: { TOKEN: 'GUGU_STDIO_TOKEN' } },
        ],
      })
    );

    expect(result.acp?.mcpServers).toEqual([
      {
        type: 'http',
        name: 'gugu',
        url: 'http://127.0.0.1:1/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer tok-1' }],
      },
      {
        type: 'stdio',
        name: 'side',
        command: 'node',
        args: ['s.mjs'],
        env: [{ name: 'TOKEN', value: '${GUGU_STDIO_TOKEN}' }],
      },
    ]);
    expect(result.env).not.toHaveProperty('GUGU_MCP_TOKEN');
    // stdio 的引用要在子进程环境里解得开 —— 这一个必须留着。
    expect(result.env.GUGU_STDIO_TOKEN).toBe('tok-2');
    expect(result.report.units.mcp).toEqual({ status: 'loaded' });
  });

  it('身份自述走 session-context(用户级载体),❌ 不回落 _meta.systemPrompt.append', () => {
    const result = materializeAntigravitySessionBundle(ctx, bundle());
    expect(result.prompt).toEqual({
      value: 'P-BLOCK I-BLOCK',
      delivered: ['platform', 'identity'],
      carrier: 'session-context',
    });
    expect(result.report.units.promptBlocks).toEqual({ status: 'loaded' });
  });

  it('平台模型响亮拒绝 —— 它只认自己目录里的 id,咕咕的别名点不了名', () => {
    expect(() =>
      materializeAntigravitySessionBundle(
        ctx,
        bundle({
          model: {
            dialect: 'gemini-env',
            model: 'gugu-alias',
            platformProvider: { baseUrl: 'http://relay/v1', apiKey: 'k' },
          } as unknown as SessionCapabilityBundle['model'],
        })
      )
    ).toThrow(/cannot deliver a Gugu platform model/);
  });

  it('拒绝没声明的腿', () => {
    expect(() =>
      materializeAntigravitySessionBundle({ ...ctx, surface: 'app-server' as never }, bundle())
    ).toThrow(/does not support surface 'app-server'/);
  });
});

describe('withLoopbackNoProxy', () => {
  it('没有 NO_PROXY 时补上回环两项(大小写两份)', () => {
    expect(withLoopbackNoProxy({})).toEqual({
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    });
  });

  it('合并而不是覆盖:用户自己的条目一个不丢,已有的回环项不重复', () => {
    expect(withLoopbackNoProxy({ NO_PROXY: 'corp.internal, localhost' })).toEqual({
      NO_PROXY: 'corp.internal,localhost,127.0.0.1',
      no_proxy: 'corp.internal,localhost,127.0.0.1',
    });
    expect(withLoopbackNoProxy({ NO_PROXY: 'a.example', no_proxy: 'b.example' })).toEqual({
      NO_PROXY: 'a.example,127.0.0.1,localhost',
      no_proxy: 'b.example,127.0.0.1,localhost',
    });
  });

  it('真 spawn 用的是同一份:buildSpawn 带着合并后的 NO_PROXY', () => {
    const spawn = pluginRegistry.get('antigravity')!.behavior.acp!.buildSpawn({
      cwd: '/work',
      env: { NO_PROXY: 'corp.internal' },
      cli: '/managed/agy_acp_server',
    });
    expect(spawn.command).toBe('/managed/agy_acp_server');
    expect(spawn.args).toEqual([]);
    expect(spawn.env).toEqual({
      NO_PROXY: 'corp.internal,127.0.0.1,localhost',
      no_proxy: 'corp.internal,127.0.0.1,localhost',
    });
  });
});
