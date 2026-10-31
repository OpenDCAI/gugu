import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { automations } from '@main/db/schema';
import { runAgentScheduleAction } from './agent-schedules';
import { AutomationScheduler } from './automation-scheduler';
import { AutomationsService } from './automations-service';
import { getAutomation, insertRun, listSessionSchedules } from './repo';

// 任务页「这个任务还会回来」读的那一份(listSessionSchedules):真库,排、到点、没送到、错过、停掉都走产品自己的路径。

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  messageSessionFrom: vi.fn(),
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/sessions/archiveSession', () => ({ archiveSession: vi.fn() }));
vi.mock('./actions/sessionCreate', () => ({ executeSessionCreate: vi.fn() }));
vi.mock('@main/core/sessions/session-orchestration', () => ({
  messageSessionFrom: mocks.messageSessionFrom,
}));

// 2026-10-19 10:00 北京时间
const NOW = Date.UTC(2026, 9, 19, 2, 0, 0);
const AGENT = { sessionId: 'ci-watch', projectId: 'project-1', provider: 'codex' };
const OTHER = { sessionId: 'other', projectId: 'project-1', provider: 'claude' };

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.messageSessionFrom.mockReset();
  mocks.messageSessionFrom.mockResolvedValue({ id: 'delivered-1' });
  fixture.sqlite
    .prepare(`INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'Home', '/home', 0, 0)`)
    .run();
  for (const id of [AGENT.sessionId, OTHER.sessionId]) {
    fixture.sqlite.prepare(`INSERT INTO sessions (id, project_id, title) VALUES (?, 'project-1', ?)`).run(id, id);
  }
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
  vi.useRealTimers();
});

function idOf(row: unknown): string {
  return (row as { schedule_id: string }).schedule_id.replace(/^schedule:/, '');
}

async function fireDue(until: (status: string) => boolean): Promise<void> {
  const seen: string[] = [];
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const scheduler = new AutomationScheduler({
    onRunStep: (run) => {
      seen.push(run.status);
      if (until(run.status)) resolve();
    },
    onScheduledRunChanged: () => {},
  });
  await scheduler.reload();
  await done;
  scheduler.stop();
}

describe('listSessionSchedules', () => {
  it('没有就是空;人建的那种(没有 agent_session_id)不算', async () => {
    expect(listSessionSchedules()).toEqual([]);
    await fixture.db.insert(automations).values({
      id: 'human-1',
      name: '人建的日报',
      triggerConfig: { expr: '0 9 * * *' },
      agentConfig: { prompt: 'daily', provider: 'codex', autoApprove: false },
      sessionConfig: null,
      projectId: 'project-1',
      enabled: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(listSessionSchedules()).toEqual([]);
  });

  it('还会回来的:按会话、下一个在前,带下一次与规则', async () => {
    const cron = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: '写站会摘要', title: '每日站会摘要', cron: '0 9 * * 1-5', tz: 'Asia/Shanghai' });
    const soon = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: '看 CI', title: '检查 CI 结果', at: '2026-10-19T10:30', tz: 'Asia/Shanghai' });
    await runAgentScheduleAction(OTHER, { action: 'schedule_create', prompt: 'theirs', at: '2026-10-19T11:00', tz: 'Asia/Shanghai' });

    const mine = listSessionSchedules().filter((item) => item.sessionId === AGENT.sessionId);
    expect(mine.map((item) => [item.id, item.title, item.nextRunAt])).toEqual([
      [idOf(soon), '检查 CI 结果', NOW + 30 * 60_000],
      // 明天(周二)09:00 北京时间。
      [idOf(cron), '每日站会摘要', Date.UTC(2026, 9, 20, 1, 0, 0)],
    ]);
    expect(mine[0]).toMatchObject({ prompt: '看 CI', enabled: true, lastRun: null, trigger: { at: NOW + 30 * 60_000 } });
    expect(mine[1]).toMatchObject({ trigger: { expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' } });
    expect(listSessionSchedules().filter((item) => item.sessionId === OTHER.sessionId)).toHaveLength(1);
  });

  it('一次性送到了:自动关掉,不再给人看', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: '看 CI', at: '2026-10-19T10:03', tz: 'Asia/Shanghai' });
    vi.setSystemTime(NOW + 3 * 60_000);
    await fireDue((status) => status === 'done');
    await vi.waitFor(async () => expect((await getAutomation(idOf(created)))?.enabled).toBe(false));
    expect(listSessionSchedules()).toEqual([]);
  });

  it('一次性没送到:关掉了也要给人看,带失败原因;阴控 —— 同样过点但送到了的那条不看', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: '看 CI', title: '检查 CI 结果', at: '2026-10-19T10:03', tz: 'Asia/Shanghai' });
    vi.setSystemTime(NOW + 3 * 60_000);
    mocks.messageSessionFrom.mockRejectedValueOnce(new Error('engine did not start'));
    await fireDue((status) => status === 'failed');
    await vi.waitFor(async () => expect((await getAutomation(idOf(created)))?.enabled).toBe(false));

    expect(listSessionSchedules()).toEqual([
      expect.objectContaining({
        id: idOf(created),
        enabled: false,
        nextRunAt: null,
        lastRun: { status: 'failed', at: NOW + 3 * 60_000, error: expect.objectContaining({ code: 'delivery_failed', message: 'engine did not start' }) },
      }),
    ]);
  });

  it('重复的错过了一次(机器关着过了点):带「错过」;下一次送到了就不再是最近一次', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'agenda', cron: '0 9 * * 1-5', tz: 'Asia/Shanghai' });
    const id = idOf(created);
    const base = { automationId: id, triggerConfigSnapshot: { expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' }, agentConfigSnapshot: { prompt: 'agenda', provider: 'codex', autoApprove: false }, triggerKind: 'cron' as const };
    const missedAt = NOW - 60 * 60_000;
    await insertRun({ ...base, status: 'skipped', scheduledAt: missedAt, finishedAt: NOW - 60_000, error: { step: 'queue', code: 'deadline_exceeded' } });
    expect(listSessionSchedules()[0]).toMatchObject({ id, lastRun: { status: 'skipped', error: { code: 'deadline_exceeded' } } });

    await insertRun({ ...base, status: 'done', scheduledAt: NOW - 30_000, startedAt: NOW - 30_000, finishedAt: NOW - 20_000 });
    expect(listSessionSchedules()[0]).toMatchObject({ id, lastRun: { status: 'done', at: NOW - 20_000 } });
  });

  it('人改了时间(那一次被 trigger_changed 跳过)不冲掉上一次没送到:⚠ 还在,直到下一次真送到', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'agenda', cron: '0 9 * * 1-5', tz: 'Asia/Shanghai' });
    const id = idOf(created);
    await insertRun({
      automationId: id,
      triggerConfigSnapshot: { expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' },
      agentConfigSnapshot: { prompt: 'agenda', provider: 'codex', autoApprove: false },
      triggerKind: 'cron',
      status: 'failed',
      scheduledAt: NOW - 60 * 60_000,
      finishedAt: NOW - 59 * 60_000,
      error: { step: 'deliver', code: 'delivery_failed' },
    });
    await new AutomationsService().updateAutomationSettings(id, { triggerConfig: { expr: '30 9 * * 1-5', tz: 'Asia/Shanghai' } });
    // 被跳过的那一次排得比失败那次晚,但它是人改出来的,不算「最近一次」。
    expect(fixture.sqlite.prepare(`SELECT count(*) FROM automation_runs WHERE automation_id = ? AND status = 'skipped'`).pluck().get(id)).toBe(1);
    expect(listSessionSchedules()[0]).toMatchObject({ id, lastRun: { status: 'failed' } });
  });

  it('人在「已安排」里停掉的不看,哪怕最近一次没送到', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'agenda', cron: '0 9 * * 1-5', tz: 'Asia/Shanghai' });
    const id = idOf(created);
    await insertRun({
      automationId: id,
      triggerConfigSnapshot: { expr: '0 9 * * 1-5', tz: 'Asia/Shanghai' },
      agentConfigSnapshot: { prompt: 'agenda', provider: 'codex', autoApprove: false },
      triggerKind: 'cron',
      status: 'failed',
      finishedAt: NOW - 60_000,
      error: { step: 'deliver', code: 'delivery_failed' },
    });
    expect(listSessionSchedules()).toHaveLength(1);
    fixture.sqlite.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(id);
    expect(listSessionSchedules()).toEqual([]);
  });

  it('取消(删掉)的不看', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: '看 CI', at: '2026-10-19T10:30', tz: 'Asia/Shanghai' });
    expect(listSessionSchedules()).toHaveLength(1);
    await runAgentScheduleAction(AGENT, { action: 'schedule_cancel', schedule_id: `schedule:${idOf(created)}` });
    expect(listSessionSchedules()).toEqual([]);
  });
});
