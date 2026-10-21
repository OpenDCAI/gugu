import { describe, expect, it } from 'vitest';
import { hasStatusSource, initialAgentStatus, initialAgentStatusDetail } from './initial-agent-status';

// #6206:状态源是由「会话的腿 + 这一家 hooks descriptor」推出的正交事实,不是活动轴的第五态。
describe('hasStatusSource / initialAgentStatus (#6206)', () => {
  it('only a TUI session of a harness whose hooks are none has no status source', () => {
    expect(hasStatusSource({ runtime: 'pty', hooksKind: 'none' })).toBe(false);
    expect(hasStatusSource({ runtime: 'pty', hooksKind: 'config' })).toBe(true);
    expect(hasStatusSource({ runtime: 'pty', hooksKind: 'plugin' })).toBe(true);
    expect(hasStatusSource({ runtime: 'acp', hooksKind: 'none' })).toBe(true);
  });

  it('a session without a status source is born null; the others keep the create / fork rule', () => {
    const create = { initialPrompt: 'hi' };
    expect(initialAgentStatus(create, { runtime: 'pty', hooksKind: 'none' })).toBeNull();
    expect(initialAgentStatus(create, { runtime: 'pty', hooksKind: 'config' })).toBe('working');
    expect(initialAgentStatus(create, { runtime: 'acp', hooksKind: 'none' })).toBe('working');
    expect(
      initialAgentStatus(
        { origin: { kind: 'fork', forkedFrom: { sessionId: 'c', title: 't' } } } as never,
        { runtime: 'pty', hooksKind: 'config' },
      ),
    ).toBe('idle');
    // #7199 常驻 agent 等主人第一条消息:没人在等它回答。
    expect(initialAgentStatus({ origin: { kind: 'resident' } }, { runtime: 'acp', hooksKind: 'config' })).toBe('idle');
  });
});

// #6448:出生的附属态与基础态同一笔落库 —— 首轮的 start 不改基础态,留空就会一直空到这一轮结束(mac1 B 臂试跑实测)。
describe('initialAgentStatusDetail', () => {
  it('a created session runs its first turn; a fork / import has not run; no status source has none', () => {
    expect(initialAgentStatusDetail('working')).toBe('running');
    expect(initialAgentStatusDetail('idle')).toBe('plain');
    expect(initialAgentStatusDetail(null)).toBeNull();
  });
});
