import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUS_DETAILS,
  AGENT_STATUSES,
  agentStatusUrgency,
  busyForVersionSwitch,
  isAgentActive,
  legacyAgentStatusWord,
  mostUrgent,
  needsAttention,
  parseAgentStatus,
  parseAgentStatusDetail,
  parseAgentStatusReading,
  readingOfStatus,
  type AgentStatusReading,
} from '@gugu/core/shared/agentStatus';

describe('agent status vocabulary', () => {
  it('四个基础态、八个附属态,各只有一处定义', () => {
    expect(AGENT_STATUSES).toEqual(['idle', 'working', 'needs_user', 'error']);
    expect(AGENT_STATUS_DETAILS).toEqual(['running', 'parked', 'approval', 'question', 'plan', 'dialog', 'done', 'plain']);
  });

  it('基础态:null 是「没有状态源」;旧词显式换算;认不出的响亮地抛', () => {
    expect(parseAgentStatus(null)).toBeNull();
    expect(parseAgentStatus(undefined)).toBeNull();
    for (const s of AGENT_STATUSES) expect(parseAgentStatus(s)).toBe(s);
    expect(parseAgentStatus('needs_approval')).toBe('needs_user');
    expect(parseAgentStatus('awaiting-input')).toBe('needs_user');
    expect(parseAgentStatus('completed')).toBe('idle');
    expect(() => parseAgentStatus('running')).toThrow(/unknown agent status/);
    expect(() => parseAgentStatus(1)).toThrow(/unknown agent status/);
  });

  it('附属态只管显示:与基础态不配、认不出、缺省都是 null', () => {
    expect(parseAgentStatusDetail('parked', 'working')).toBe('parked');
    expect(parseAgentStatusDetail('question', 'needs_user')).toBe('question');
    expect(parseAgentStatusDetail('done', 'idle')).toBe('done');
    expect(parseAgentStatusDetail('running', 'idle')).toBeNull();
    expect(parseAgentStatusDetail('done', 'error')).toBeNull();
    expect(parseAgentStatusDetail('someday', 'working')).toBeNull();
    expect(parseAgentStatusDetail('running', null)).toBeNull();
    expect(parseAgentStatusDetail(null, 'working')).toBeNull();
  });

  it('线上的读数:形状对才收,null 是没有状态源', () => {
    expect(parseAgentStatusReading(null)).toBeNull();
    expect(parseAgentStatusReading({ status: 'needs_approval', detail: 'plan', running: true, background: null })).toEqual({
      status: 'needs_user',
      detail: 'plan',
      running: true,
      background: null,
    });
    expect(parseAgentStatusReading({ status: 'working', detail: 'parked', running: false })).toEqual({
      status: 'working',
      detail: 'parked',
      running: false,
      background: null,
    });
    expect(() => parseAgentStatusReading({ detail: 'done', running: false })).toThrow(/no status/);
    expect(() => parseAgentStatusReading({ status: 'idle' })).toThrow(/running/);
    expect(() => parseAgentStatusReading({ status: 'working', running: false, background: 'soon' })).toThrow(/background/);
    expect(() => parseAgentStatusReading('idle')).toThrow(/not an object/);
  });

  it('只知道基础态的来源:在跑与等人算有一轮在飞', () => {
    expect(readingOfStatus('working')).toEqual({ status: 'working', detail: null, running: true, background: null });
    expect(readingOfStatus('needs_user').running).toBe(true);
    expect(readingOfStatus('idle').running).toBe(false);
  });

  it('写给老客户端的字段用旧词', () => {
    expect(legacyAgentStatusWord('needs_user')).toBe('needs_approval');
    expect(legacyAgentStatusWord('working')).toBe('working');
    expect(legacyAgentStatusWord(null)).toBeNull();
  });
});

describe('agent status projections', () => {
  const r = (status: AgentStatusReading['status'], detail: AgentStatusReading['detail'] = null) => ({ status, detail });

  it('云端 running 投影 = 在跑(含 park)或停在等人上', () => {
    expect(isAgentActive(r('working', 'parked'))).toBe(true);
    expect(isAgentActive(r('needs_user'))).toBe(true);
    expect(isAgentActive(r('error'))).toBe(false);
    expect(isAgentActive(r('idle', 'done'))).toBe(false);
    expect(isAgentActive(null)).toBe(false);
  });

  it('要人来处理 = 需要你或出错', () => {
    expect(needsAttention('needs_user')).toBe(true);
    expect(needsAttention('error')).toBe(true);
    expect(needsAttention('working')).toBe(false);
    expect(needsAttention(null)).toBe(false);
  });

  it('紧急度:需要你 > 出错 > 在跑 > 做完未读 > 空闲 > 没有状态源', () => {
    const order = [
      agentStatusUrgency(r('needs_user')),
      agentStatusUrgency(r('error')),
      agentStatusUrgency(r('working', 'running')),
      agentStatusUrgency(r('idle', 'done'), true),
      agentStatusUrgency(r('idle', 'done'), false),
      agentStatusUrgency(null),
    ];
    expect([...order].sort((a, b) => b - a)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
    expect(agentStatusUrgency(r('idle', 'plain'), true)).toBe(agentStatusUrgency(r('idle', 'done'), false));
  });

  it('汇总只按紧急度取最高,平手取先出现的', () => {
    const items = [
      { id: 'a', reading: r('working', 'running') },
      { id: 'b', reading: r('needs_user', 'approval') },
      { id: 'c', reading: r('needs_user', 'question') },
      { id: 'd', reading: r('error') },
    ];
    expect(mostUrgent(items, (i) => ({ reading: i.reading }))?.id).toBe('b');
    expect(mostUrgent([], (i: { reading: null }) => ({ reading: i.reading }))).toBeUndefined();
  });
});

describe('busyForVersionSwitch(#6264 server 换版时算不算忙)', () => {
  const r = (status: AgentStatusReading['status']) => ({ status });
  it.each([
    ['ACP 会话在跑:随宿主死', r('working'), 'acp', null, true],
    ['ACP 会话在等人批准', r('needs_user'), 'acp', null, true],
    ['进程归 tmux 的终端会话在跑:换版后接回', r('working'), 'pty', 'tmux', false],
    ['进程归 tmux 的终端会话在等人', r('needs_user'), 'pty', 'tmux', false],
    ['进程归宿主的终端会话在跑:随宿主死', r('working'), 'pty', 'host', true],
    ['本宿主里没有它的进程(还在 tmux 里等接回)', r('working'), 'pty', null, false],
    ['说不清是哪种的会话在跑:照算', r('working'), 'unknown', null, true],
    ['空闲的 ACP 会话', r('idle'), 'acp', null, false],
    ['空闲的、进程归宿主的终端会话', r('idle'), 'pty', 'host', false],
    ['没有状态源', null, 'acp', null, false],
  ] as const)('%s', (_name, reading, runtime, home, busy) => {
    expect(busyForVersionSwitch(reading, runtime, home)).toBe(busy);
  });
});
