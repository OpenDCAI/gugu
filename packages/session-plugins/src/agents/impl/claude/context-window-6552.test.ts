/**
 * #6552 —— 聊天面板腿的上下文上限:桥接在 Claude 确认之前报的是按模型名猜的数。
 *
 * - 物化器把桥接自己的状态目录(确认过的窗口跨进程保存在这里)只交给**适配器进程**,
 *   不交给 claude,也不落在用户的 `~/.claude`;
 * - 桥接标成「猜的」那种读数,上限一律当「未知」,composer 不画。
 */
import { join } from 'node:path';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@gugu/session-core/acp';
import type { SessionMaterialization } from '@gugu/session-core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { CLAUDE_GUGU_CAPABILITY_PACKAGE, pluginRegistry } from '../../registry';
import { enrichClaudeUpdate } from './acp-transform';
import { CLAUDE_ACP_BRIDGE_STATE_DIR_ENV } from './session-bundle';

const GUGU_HOME = '/gugu-home-under-test';

function materialize(
  surface: 'acp' | 'tui',
  env: Record<string, string>,
  packages = [CLAUDE_GUGU_CAPABILITY_PACKAGE],
): SessionMaterialization {
  const materializer = pluginRegistry.get('claude')!.behavior.sessionBundle!.materialize;
  return materializer(
    { surface, lifecycle: 'fresh', cwd: '/worktree' },
    {
      mcpServers: [],
      env,
      model: null,
      autonomy: null,
      promptBlocks: {},
      packages,
    } as never
  );
}

function claudeOptionsEnv(m: SessionMaterialization): Record<string, string> {
  const meta = m.acp?.meta as { claudeCode?: { options?: { env?: Record<string, string> } } } | undefined;
  return meta?.claudeCode?.options?.env ?? {};
}

describe('claude bridge state dir (#6552)', () => {
  it('goes to the adapter process of a chat-panel session, under GUGU_HOME', () => {
    const m = materialize('acp', { GUGU_HOME });
    expect(m.env[CLAUDE_ACP_BRIDGE_STATE_DIR_ENV]).toBe(
      join(GUGU_HOME, 'acp-bridges', 'claude-agent-acp-state')
    );
  });

  it('is not handed to claude itself', () => {
    const m = materialize('acp', { GUGU_HOME });
    expect(claudeOptionsEnv(m)).not.toHaveProperty(CLAUDE_ACP_BRIDGE_STATE_DIR_ENV);
  });

  it('is absent on the terminal leg, which runs no bridge', () => {
    const m = materialize('tui', { GUGU_HOME });
    expect(m.env).not.toHaveProperty(CLAUDE_ACP_BRIDGE_STATE_DIR_ENV);
  });

  it('is absent without a data root', () => {
    // 带着咕咕的能力包时数据根本来就是必需的(那一份自己会响亮失败);这里只量本变量这一格。
    const m = materialize('acp', {}, []);
    expect(m.env).not.toHaveProperty(CLAUDE_ACP_BRIDGE_STATE_DIR_ENV);
  });
});

describe('a 1M claude-* platform model is named the way Claude Code reads a 1M window', () => {
  const withModel = (surface: 'acp' | 'tui', model: Record<string, unknown>): SessionMaterialization =>
    pluginRegistry.get('claude')!.behavior.sessionBundle!.materialize(
      { surface, lifecycle: 'fresh', cwd: '/worktree' },
      { mcpServers: [], env: { GUGU_HOME }, model, autonomy: null, promptBlocks: {}, packages: [] } as never
    );
  const platform = { baseUrl: 'https://relay.test.invalid/v1', apiKey: 'k' };

  it('on both surfaces, background tiers included', () => {
    for (const surface of ['acp', 'tui'] as const) {
      const m = withModel(surface, { dialect: 'provider-env', model: 'claude-opus-5', platformProvider: platform, contextWindow: 1_000_000 });
      expect(m.env.ANTHROPIC_MODEL).toBe('claude-opus-5[1m]');
      expect(m.env.ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-opus-5[1m]');
    }
  });

  it('not off the platform, where the id is the user’s own', () => {
    const m = withModel('tui', { dialect: 'provider-env', model: 'claude-opus-5', contextWindow: 1_000_000 });
    expect(m.env.ANTHROPIC_MODEL).toBe('claude-opus-5');
  });
});

describe('context window the bridge only guessed (#6552)', () => {
  const usage = (size: number): NormalizedEvent => ({
    kind: 'usage',
    usage: { contextUsed: 58_000, contextSize: size, cost: null },
  });
  const raw = (meta: Record<string, unknown> | undefined): SessionUpdate =>
    ({ sessionUpdate: 'usage_update', used: 58_000, size: 200_000, ...(meta ? { _meta: meta } : {}) }) as never;

  it('is read as an unknown limit', () => {
    const out = enrichClaudeUpdate(usage(200_000), raw({ '_claude/contextWindowEstimated': true }));
    expect(out).toEqual({ kind: 'usage', usage: { contextUsed: 58_000, contextSize: 0, cost: null } });
  });

  it('leaves a confirmed limit as reported', () => {
    const event = usage(1_000_000);
    expect(enrichClaudeUpdate(event, raw({ '_claude/model': 'claude-opus-5-5' }))).toBe(event);
    expect(enrichClaudeUpdate(event, raw(undefined))).toBe(event);
  });
});
