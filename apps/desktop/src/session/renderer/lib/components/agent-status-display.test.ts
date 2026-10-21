import { describe, expect, it } from 'vitest';
import type { AgentStatus, AgentStatusDetail } from '@gugu/core/shared/agentStatus';
import { aggregateStatusDetail } from './agent-status-display';

const member = (status: AgentStatus | null, detail: AgentStatusDetail | null = null) => ({ status, detail });

// 一组会话汇成一格(任务行、标签、命令面板):附属态跟着 sessionStatus 选出的基础态走。
describe('aggregateStatusDetail', () => {
  it('working: one conversation still in a turn makes the cell spin', () => {
    expect(aggregateStatusDetail('working', [member('working', 'parked'), member('working', 'running')])).toBe('running');
    // 附属态缺席(老行)算在跑,❌ 算后台。
    expect(aggregateStatusDetail('working', [member('working', 'parked'), member('working')])).toBe('running');
  });

  it('working: only when every working conversation is parked does the cell rest', () => {
    expect(aggregateStatusDetail('working', [member('working', 'parked'), member('idle', 'done')])).toBe('parked');
  });

  it('needs_user: names the most urgent wait, in the host reducer order', () => {
    expect(
      aggregateStatusDetail('needs_user', [member('needs_user', 'dialog'), member('needs_user', 'question')])
    ).toBe('question');
    expect(
      aggregateStatusDetail('needs_user', [member('needs_user', 'plan'), member('needs_user', 'approval')])
    ).toBe('approval');
    expect(aggregateStatusDetail('needs_user', [member('needs_user')])).toBeNull();
  });

  it('error, idle and no status carry no detail', () => {
    expect(aggregateStatusDetail('error', [member('error')])).toBeNull();
    expect(aggregateStatusDetail('idle', [member('idle', 'done')])).toBeNull();
    expect(aggregateStatusDetail(null, [])).toBeNull();
  });
});
