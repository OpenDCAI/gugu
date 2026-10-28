import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentRosterEntry } from '@gugu/session-chat-ui';

const mocks = vi.hoisted(() => ({
  roster: [] as SubagentRosterEntry[],
  store: {} as unknown
}));

// 只挡住取 store 那一步:这几条用例验的是「按了 × 之后面板还画不画它」,
// 与转录怎么收出花名册无关。
vi.mock('@renderer/features/sessions/acp/acp-chat-resource-manager', () => ({
  findAcpChatStore: () => mocks.store
}));
vi.mock('@gugu/session-chat-ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@gugu/session-chat-ui')>()),
  collectSubagentRoster: () => mocks.roster
}));

const { collectSubagents } = await import('./background-task-rosters');
const { dismissSubagent, isSubagentDismissed, resetSubagentDismissals } = await import(
  './subagent-dismissals'
);

function entry(id: string): SubagentRosterEntry {
  return {
    id,
    launchToolCallId: `call-${id}`,
    name: id,
    completedSteps: 0,
    calls: [],
    elapsedMs: 1000
  };
}

const CONV = 'conv-1';
const ids = (): string[] =>
  collectSubagents(CONV, 'subagent').map((agentEntry) => agentEntry.id);

/**
 * owner 2026-09-06:「被放弃的派发永远停在运行中…可以手动关掉也行,悬浮出个 x 号」。
 *
 * 这一组守的是**关掉之后它真的不见了**,以及关掉这件事**只对按下的那一张、那一个会话**
 * 生效 —— 一个漏了会话的键会让别处的卡跟着消失,而那种错在面板上看不出来。
 */
describe('#4981 手动收起一张子智能体卡', () => {
  beforeEach(() => {
    resetSubagentDismissals();
    mocks.store = { messageCount: 0, chatState: { transcript: { state: {} } } };
    mocks.roster = [entry('a'), entry('b')];
  });

  it('❌ 阴控:没人按过 × 时,两张都在', () => {
    expect(ids()).toEqual(['a', 'b']);
  });

  it('按下的那一张不再画,另一张不受影响', () => {
    dismissSubagent(CONV, 'a');
    expect(ids()).toEqual(['b']);
  });

  /**
   * 那一行跟着转录的虚拟列表滚出视窗就卸载,所以这个状态**不能**
   * 放在组件里。这条用例就是那件事的判据:同一个模块再问一次,答案还在。
   *
   * ⚠️ 它验的是「状态活在模块里」,不是「React 不会重挂」—— 后者这层测不到,
   * 而前者一旦写回组件 state,这条会红。
   */
  it('状态活过面板的卸载(不放在组件里)', () => {
    dismissSubagent(CONV, 'a');
    // 面板关掉再开 = 重新调一次收集函数,中间没有任何组件实例存活。
    expect(ids()).toEqual(['b']);
    expect(ids()).toEqual(['b']);
  });

  it('只对这个会话生效 —— 换个会话,同一个 id 照旧在', () => {
    dismissSubagent(CONV, 'a');
    expect(isSubagentDismissed('conv-2', 'a')).toBe(false);
    expect(collectSubagents('conv-2', 'subagent').map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('没有会话 id 时整节不画 —— ❌ 不拿一个空键去记', () => {
    expect(collectSubagents(undefined, 'subagent')).toEqual([]);
  });
});
