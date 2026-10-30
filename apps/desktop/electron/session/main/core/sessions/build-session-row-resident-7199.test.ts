import { describe, expect, it } from 'vitest';
import { buildSessionRow } from './build-session-row';

/**
 * #7199 云端 `agent.create` 不带首句建出来的常驻 agent:等主人的第一条消息,出生 idle / plain、不记首轮。
 * 从前记一句占位当首轮 ⇒ 出生 working / running 且永远等不到收尾,云电脑的管家据此判「忙」,永远不睡。
 */
const base = {
  id: 'r1',
  projectId: 'p1',
  workspaceId: 'w1',
  title: '个人助理',
  claimsFirstSpawn: false,
  runtime: 'acp' as const,
};

describe('a resident agent waits for its first message (#7199)', () => {
  it('is born idle with nothing recorded as its first turn', () => {
    const row = buildSessionRow({ ...base, provider: 'pi' as never, origin: { kind: 'resident' } });
    expect(row.agentStatus).toBe('idle');
    expect(row.agentStatusDetail).toBe('plain');
    expect(row.config).not.toHaveProperty('firstUtterance');
  });

  it('a created session still runs its first turn from birth', () => {
    const row = buildSessionRow({ ...base, provider: 'pi' as never, origin: { kind: 'create', firstUtterance: 'hi' } });
    expect(row.agentStatus).toBe('working');
    expect(row.agentStatusDetail).toBe('running');
  });

  it.each(['acp', 'pty'] as const)('keeps an explicit creation name as both task and identity on %s', (runtime) => {
    const row = buildSessionRow({ ...base, runtime, provider: 'codex', title: 'Derived prompt title',
      agentDisplayName: 'Explicit choice', initialPrompt: 'Review the patch' });
    expect(row.title).toBe('Explicit choice');
    expect(row.config).toMatchObject({ agentDisplayName: 'Explicit choice', titleSource: 'manual', identityNameManaged: true });
  });

  it('does not impose the linked-task name limit on an independent resident', () => {
    const row = buildSessionRow({ ...base, provider: 'pi', origin: { kind: 'resident' }, agentDisplayName: 'x'.repeat(60) });
    expect(row.config?.agentDisplayName).toBe('x'.repeat(60));
    expect(row.config).not.toHaveProperty('identityNameManaged');
  });

  it('does not turn a legacy or internal long title into a late row-construction failure', () => {
    const title = 'x'.repeat(60);
    expect(buildSessionRow({ ...base, provider: 'codex', title, titleSource: 'manual', initialPrompt: 'Review the patch' }).title).toBe(title);
  });
});
