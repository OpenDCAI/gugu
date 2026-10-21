import { describe, expect, it } from 'vitest';
import {
  compareSessionSchedules,
  scheduleAttention,
  scheduleShown,
  sessionScheduleDigest,
  type SessionSchedule,
} from './session-schedule';

const NOW = Date.UTC(2026, 9, 19, 2, 0, 0);

function schedule(patch: Partial<SessionSchedule>): SessionSchedule {
  return {
    id: 'a',
    sessionId: 's',
    title: '检查 CI 结果',
    prompt: 'look at CI',
    trigger: { expr: '', at: NOW + 30 * 60_000 },
    enabled: true,
    nextRunAt: NOW + 30 * 60_000,
    lastRun: null,
    ...patch,
  };
}

describe('scheduleAttention:最近一次没送到才提醒', () => {
  it.each([
    [null, null],
    [{ status: 'done' as const, at: NOW, error: null }, null],
    [{ status: 'failed' as const, at: NOW, error: { step: 'deliver' as const, code: 'delivery_failed' } }, 'failed'],
    [{ status: 'skipped' as const, at: NOW, error: { step: 'queue' as const, code: 'deadline_exceeded' } }, 'missed'],
    [{ status: 'skipped' as const, at: NOW, error: { step: 'queue' as const, code: 'previous_running' } }, 'missed'],
    // 人自己做的(停、删、改规则)不提醒。
    [{ status: 'skipped' as const, at: NOW, error: { step: 'queue' as const, code: 'disabled' } }, null],
    [{ status: 'skipped' as const, at: NOW, error: { step: 'queue' as const, code: 'trigger_changed' } }, null],
  ])('%j → %s', (lastRun, expected) => {
    expect(scheduleAttention({ lastRun })).toBe(expected);
  });
});

describe('scheduleShown', () => {
  const failed = { status: 'failed' as const, at: NOW - 60_000, error: { step: 'deliver' as const, code: 'delivery_failed' } };

  it('还会回来的看', () => {
    expect(scheduleShown(schedule({}), NOW)).toBe(true);
  });
  it('一次性跑完了(自动关掉、最后一次送到了)不看', () => {
    const at = NOW - 60_000;
    expect(scheduleShown(schedule({ trigger: { expr: '', at }, enabled: false, nextRunAt: null, lastRun: { status: 'done', at, error: null } }), NOW)).toBe(false);
  });
  it('一次性过了点、最后一次没送到:看(那是它唯一的一次)', () => {
    const at = NOW - 60_000;
    expect(scheduleShown(schedule({ trigger: { expr: '', at }, enabled: false, nextRunAt: null, lastRun: failed }), NOW)).toBe(true);
  });
  it('人在「已安排」里停掉的不看,哪怕最近一次没送到', () => {
    expect(scheduleShown(schedule({ trigger: { expr: '0 9 * * 1-5' }, enabled: false, nextRunAt: null, lastRun: failed }), NOW)).toBe(false);
    // 还没到点就被停掉的一次性同样不看。
    expect(scheduleShown(schedule({ enabled: false, nextRunAt: null, lastRun: failed }), NOW)).toBe(false);
  });
  it('重复的开着、上一次没送到:看', () => {
    expect(scheduleShown(schedule({ trigger: { expr: '0 9 * * 1-5' }, lastRun: failed }), NOW)).toBe(true);
  });
});

describe('sessionScheduleDigest:行上那枚标记', () => {
  it('没有就是 null', () => {
    expect(sessionScheduleDigest([])).toBeNull();
  });

  it('下一个要回来的那条给时间和标题;没送到的那条带它自己的标题', () => {
    const list = [
      schedule({ id: 'late', title: '汇报 PR 评审', nextRunAt: NOW + 3 * 3600_000 }),
      schedule({ id: 'gone', title: '回归汇总', enabled: false, nextRunAt: null, trigger: { expr: '', at: NOW - 60_000 }, lastRun: { status: 'failed', at: NOW - 60_000, error: { step: 'deliver', code: 'delivery_failed' } } }),
      schedule({ id: 'soon', title: '检查 CI 结果', nextRunAt: NOW + 30 * 60_000 }),
    ].sort(compareSessionSchedules);
    expect(list.map((item) => item.id)).toEqual(['soon', 'late', 'gone']);
    expect(sessionScheduleDigest(list)).toEqual({
      count: 3,
      nextAt: new Date(NOW + 30 * 60_000).toISOString(),
      title: '检查 CI 结果',
      attention: { kind: 'failed', title: '回归汇总' },
    });
  });

  it('只剩没送到的:没有下一次,标题是那一条的', () => {
    const only = schedule({ title: '回归汇总', enabled: false, nextRunAt: null, trigger: { expr: '', at: NOW - 60_000 }, lastRun: { status: 'skipped', at: NOW - 60_000, error: { step: 'queue', code: 'deadline_exceeded' } } });
    expect(sessionScheduleDigest([only])).toEqual({ count: 1, nextAt: null, title: '回归汇总', attention: { kind: 'missed', title: '回归汇总' } });
  });
});
