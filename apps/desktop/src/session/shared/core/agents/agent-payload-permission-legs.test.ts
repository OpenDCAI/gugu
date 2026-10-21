import { describe, expect, it } from 'vitest';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { agentSupportsPermissionMode, agentSupportsReadOnlyMode } from './agent-payload';

// 档位按腿摆:antigravity 的只读只在聊天面板腿兑现(agy 1.4.0 没有选它的旗标),终端腿的界面不摆。
describe('权限档按腿判定', () => {
  const capabilities = (id: string) => pluginRegistry.get(id)!.capabilities as never;

  it('antigravity 的只读:聊天面板腿有,终端腿没有', () => {
    expect(agentSupportsReadOnlyMode(capabilities('antigravity'), 'acp')).toBe(true);
    expect(agentSupportsReadOnlyMode(capabilities('antigravity'), 'tui')).toBe(false);
    expect(agentSupportsPermissionMode(capabilities('antigravity'), 'edit', 'tui')).toBe(true);
  });

  it('没写 legs 的档两条腿都摆', () => {
    expect(agentSupportsReadOnlyMode(capabilities('claude'), 'tui')).toBe(true);
    expect(agentSupportsReadOnlyMode(capabilities('claude'), 'acp')).toBe(true);
  });
});
