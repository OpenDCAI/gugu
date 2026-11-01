import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { buildSessionRow } from './build-session-row';

/**
 * #6206 —— 出生状态经真注册表的 hooks descriptor 判:gemini(hooks none)的终端会话出生即 `null`,
 * 它的 ACP 腿、以及有 hooks 的 claude 终端腿照旧是 `working`。❌ 用手写的假 descriptor:判据要对的是
 * 产品里那一份声明。
 */
const create = {
  id: 'c1',
  projectId: 'p1',
  workspaceId: 'w1',
  title: 'T',
  agentDisplayName: 'Codex 1',
  origin: { kind: 'create' as const, firstUtterance: 'hi' },
  claimsFirstSpawn: false,
};

describe('conversation birth status follows the status source (#6206)', () => {
  it('the fixtures are what the registry declares', () => {
    expect(pluginRegistry.get('gemini')?.capabilities.hooks.kind).toBe('none');
    expect(pluginRegistry.get('claude')?.capabilities.hooks.kind).not.toBe('none');
  });

  it('a hookless harness on the TUI leg is born null; its ACP leg and a hooked TUI leg are born working', () => {
    expect(buildSessionRow({ ...create, provider: 'gemini' as never, runtime: 'pty' }).agentStatus).toBeNull();
    expect(buildSessionRow({ ...create, provider: 'gemini' as never, runtime: 'acp' }).agentStatus).toBe('working');
    expect(buildSessionRow({ ...create, provider: 'claude' as never, runtime: 'pty' }).agentStatus).toBe('working');
  });

  it('an unknown provider fails loudly instead of being treated as hooked', () => {
    expect(() => buildSessionRow({ ...create, provider: 'no-such-harness' as never, runtime: 'pty' }))
      .toThrow(/unknown agent provider 'no-such-harness'/);
  });
});
