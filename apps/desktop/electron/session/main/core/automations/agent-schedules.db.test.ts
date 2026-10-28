import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { AutomationRun } from '@shared/core/automations/automation-run';
import { executeAgentDelivery } from './actions/deliverToAgent';
import { agentScheduleChangeText, restoreAgentSchedules, runAgentScheduleAction, tellAgentScheduleChanged } from './agent-schedules';
import { AutomationScheduler, type SchedulerCallbacks } from './automation-scheduler';
import { deleteSession } from '@main/core/sessions/deleteSession';
import { AutomationsService } from './automations-service';
import { closeSpentOneTimeAutomation, getAutomation, insertRun } from './repo';
import { setOwnerTimeZoneContext } from '@shared/core/automations/timezone';

// #7221 agent 给自己排的已安排:建、看、取消、到点送回、建它的会话不在了。读写的是真库(迁移跑到最新),
// 投递的那一头(会话编排的 messageSessionFrom)换成记录器 —— 它本身由 session_message 那套测试守。

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
vi.mock('@main/core/sessions/deleteSession', () => ({ deleteSession: vi.fn() }));
// 人建的那种到点开会话;这里只走 agent 那一支,开会话那一整套不必拖进来。
vi.mock('./actions/sessionCreate', () => ({ executeSessionCreate: vi.fn() }));
vi.mock('@main/core/sessions/session-orchestration', () => ({
  messageSessionFrom: mocks.messageSessionFrom,
}));

/** 云电脑管家睡前算「下一次到期」的那条查询,逐字(夜间统筹转来的硬约束)。新的这一类必须被它看见。 */
const KEEPER_NEXT_DUE = `select min(r.scheduled_at) as next from automation_runs r join automations a on a.id = r.automation_id where r.status = 'scheduled' and a.enabled = 1 and a.deleted_at is null`;

// 2026-10-15 06:00 北京时间
const NOW = Date.UTC(2026, 9, 14, 22, 0, 0);
const AGENT = { sessionId: 'assistant-session', projectId: 'project-1', provider: 'claude' };
const OTHER = { sessionId: 'other-session', projectId: 'project-1', provider: 'codex' };

let fixture: Awaited<ReturnType<typeof openFixture>>;
let service: AutomationsService;

function seedProjectAndSessions(): void {
  fixture.sqlite
    .prepare(`INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('project-1', 'Home', '/home', 0, 0)`)
    .run();
  for (const id of [AGENT.sessionId, OTHER.sessionId]) {
    fixture.sqlite
      .prepare(`INSERT INTO sessions (id, project_id, title) VALUES (?, 'project-1', ?)`)
      .run(id, id === AGENT.sessionId ? '个人助理' : 'Other');
  }
}

function keeperNextDue(): number | null {
  return (fixture.sqlite.prepare(KEEPER_NEXT_DUE).get() as { next: number | null }).next;
}

function scheduleIdOf(row: unknown): string {
  return (row as { schedule_id: string }).schedule_id.replace(/^schedule:/, '');
}

function recordingCallbacks() {
  const steps: AutomationRun[] = [];
  const waiters = new Set<{ holds: () => boolean; resolve: () => void }>();
  const notify = () => {
    for (const waiter of waiters) {
      if (!waiter.holds()) continue;
      waiters.delete(waiter);
      waiter.resolve();
    }
  };
  const callbacks: SchedulerCallbacks = {
    onRunStep: (run) => {
      steps.push(run);
      notify();
    },
    onScheduledRunChanged: () => notify(),
  };
  const when = (holds: () => boolean) =>
    new Promise<void>((resolve) => (holds() ? resolve() : waiters.add({ holds, resolve })));
  return { callbacks, steps, when };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.messageSessionFrom.mockReset();
  mocks.messageSessionFrom.mockResolvedValue({ id: 'delivered-1' });
  service = new AutomationsService();
  seedProjectAndSessions();
});

afterEach(() => {
  setOwnerTimeZoneContext(null);
  fixture.close();
  mocks.db = undefined;
  vi.useRealTimers();
});

describe('schedule_create / schedule_list / schedule_cancel', () => {
  it('new default schedules follow the owner zone while an existing explicit schedule remains unchanged', async () => {
    const original = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'existing', cron: '0 8 * * *', tz: 'America/Toronto' }, service);
    const before = await getAutomation(scheduleIdOf(original));
    const context = { time_zone: 'Pacific/Auckland', source_device_id: 'phone', source_last_seen_at: null,
      read_at: new Date(NOW).toISOString(), status: 'device' as const };
    setOwnerTimeZoneContext(context);
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'new', cron: '0 8 * * *' }, service);
    expect(created).toMatchObject({ tz: 'Pacific/Auckland', next_run_at: '2026-10-16 08:00 Pacific/Auckland', time_zone_source: context });
    expect((await getAutomation(scheduleIdOf(original)))?.triggerConfig).toEqual(before?.triggerConfig);
  });
  it('一次性:建好就预排那一行 scheduled,管家的查询读得到那一刻;回执按 tz 报时间', async () => {
    expect(keeperNextDue()).toBeNull();
    const created = await runAgentScheduleAction(AGENT, {
      action: 'schedule_create',
      prompt: '在私聊 chat:dm-1 里 message_send 提醒 user:u-1 喝水',
      at: '2026-10-15T06:03',
      tz: 'Asia/Shanghai',
    });
    expect(created).toMatchObject({
      // 没给 title:取交代的第一行,长了截到 40 个字。
      title: '在私聊 chat:dm-1 里 message_send 提醒 user:u-1…',
      at: '2026-10-15 06:03 Asia/Shanghai',
      cron: null,
      active: true,
      next_run_at: '2026-10-15 06:03 Asia/Shanghai',
      last_run: null,
    });
    expect(keeperNextDue()).toBe(NOW + 3 * 60_000);

    const automation = await getAutomation(scheduleIdOf(created));
    expect(automation).toMatchObject({
      agentSessionId: AGENT.sessionId,
      projectId: 'project-1',
      enabled: true,
      agentSession: { name: '个人助理', gone: false },
    });
  });

  it('重复:每天 8 点(北京时间)排的是今天 08:00 那一次', async () => {
    const created = await runAgentScheduleAction(AGENT, {
      action: 'schedule_create',
      prompt: 'send the agenda',
      cron: '0 8 * * *',
      tz: 'Asia/Shanghai',
      title: '每日日程',
    });
    expect(created).toMatchObject({ title: '每日日程', cron: '0 8 * * *', at: null, next_run_at: '2026-10-15 08:00 Asia/Shanghai' });
    expect(keeperNextDue()).toBe(Date.UTC(2026, 9, 15, 0, 0, 0));
  });

  it('只看得到、只取消得了自己的;取消后管家的查询不再看见它', async () => {
    const mine = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'mine', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    await runAgentScheduleAction(OTHER, { action: 'schedule_create', prompt: 'theirs', at: '2026-10-15T09:00', tz: 'Asia/Shanghai' });

    const listed = (await runAgentScheduleAction(AGENT, { action: 'schedule_list' })) as { schedules: Array<{ prompt: string }> };
    expect(listed.schedules.map((row) => row.prompt)).toEqual(['mine']);

    const mineId = (mine as { schedule_id: string }).schedule_id;
    await expect(runAgentScheduleAction(OTHER, { action: 'schedule_cancel', schedule_id: mineId })).rejects.toThrow(/no schedule .* of yours/);
    expect(keeperNextDue()).toBe(Date.UTC(2026, 9, 14, 23, 0, 0));

    await expect(runAgentScheduleAction(AGENT, { action: 'schedule_cancel', schedule_id: mineId })).resolves.toEqual({ schedule_id: mineId, cancelled: true });
    expect(await getAutomation(scheduleIdOf(mine))).toBeNull();
    // 取消只删这一条和它的运行记录;建它的会话不是运行建出来的,原样留着。
    expect(deleteSession).not.toHaveBeenCalled();
    expect(fixture.sqlite.prepare('SELECT id FROM sessions WHERE id = ?').get(AGENT.sessionId)).toBeTruthy();
    // 剩下的是别人那条 09:00。
    expect(keeperNextDue()).toBe(Date.UTC(2026, 9, 15, 1, 0, 0));
  });

  it('不足一分钟的一次性在建的时候就拒,什么都不留下', async () => {
    await expect(
      runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'too soon', at: '2026-10-15T06:00:30', tz: 'Asia/Shanghai' })
    ).rejects.toThrow(/less than a minute/);
    expect((await runAgentScheduleAction(AGENT, { action: 'schedule_list' }) as { schedules: unknown[] }).schedules).toEqual([]);
    expect(keeperNextDue()).toBeNull();
  });

  it('界面上能停、删、改名,也能改时间(owner 10-19 A);交代与别的设置改不了', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'x', cron: '0 8 * * *', tz: 'Asia/Shanghai' });
    const id = scheduleIdOf(created);
    await expect(
      service.updateAutomationSettings(id, { agentConfig: { prompt: 'y', provider: 'claude', autoApprove: false } })
    ).rejects.toThrow('agent_schedule_not_editable');
    await expect(
      service.updateAutomationSettings(id, { triggerConfig: { expr: '0 9 * * *', tz: 'Asia/Shanghai' }, projectId: 'project-1' })
    ).rejects.toThrow('agent_schedule_not_editable');

    const moved = await service.updateAutomationSettings(id, { triggerConfig: { expr: '0 9 * * *', tz: 'Asia/Shanghai' } });
    expect(moved.triggerConfig).toEqual({ expr: '0 9 * * *', tz: 'Asia/Shanghai' });
    expect(moved.agentConfig?.prompt).toBe('x');
    // 排着的那一次换成新规则的下一次(今天 09:00 北京时间),管家跟着看到。
    expect(keeperNextDue()).toBe(Date.UTC(2026, 9, 15, 1, 0, 0));
  });

  it('改时间的判据与建的时候同一套:一次性要在一分钟以后,cron 要读得懂', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'x', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    const id = scheduleIdOf(created);
    await expect(service.updateAutomationSettings(id, { triggerConfig: { expr: '', tz: 'Asia/Shanghai', at: NOW + 30_000 } })).rejects.toThrow('schedule_too_soon');
    await expect(service.updateAutomationSettings(id, { triggerConfig: { expr: 'not a cron', tz: 'Asia/Shanghai' } })).rejects.toThrow('cron_invalid');
    // 被拒的没动它:还在原来那一刻。
    expect(keeperNextDue()).toBe(Date.UTC(2026, 9, 14, 23, 0, 0));

    await service.updateAutomationSettings(id, { triggerConfig: { expr: '', tz: 'Asia/Shanghai', at: NOW + 2 * 3600_000 } });
    expect(keeperNextDue()).toBe(NOW + 2 * 3600_000);
  });
});

describe('到点送回建它的会话', () => {
  async function dueOneTimeRun(prompt = 'remind them to drink water'): Promise<{ id: string; run: AutomationRun }> {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt, at: '2026-10-15T06:03', tz: 'Asia/Shanghai' });
    const id = scheduleIdOf(created);
    vi.setSystemTime(NOW + 3 * 60_000);
    return { id, run: (await service.getNextScheduledRun(id))! };
  }

  it('调度器到点把交代原样送回那条会话(不开会话);一次性的跑完就关,管家不再为它醒', async () => {
    const { id, run } = await dueOneTimeRun();
    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks);
    await scheduler.reload();
    await record.when(() => record.steps.some((run) => run.status === 'done'));
    await record.when(() => fixture.sqlite.prepare('SELECT enabled FROM automations WHERE id = ?').pluck().get(id) === 0);

    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    const [envelope, sessionId, text, options] = mocks.messageSessionFrom.mock.calls[0]!;
    expect(sessionId).toBe(AGENT.sessionId);
    expect(text).toBe('remind them to drink water');
    expect(options).toMatchObject({ keyScope: `automation:${id}`, receipt: { id: expect.any(String), at: new Date(run.scheduledAt!).toISOString() } });

    const delivered = readDeliveryEnvelope((envelope as (messageId: string, said: string) => string)('m-1', text as string));
    const facts = delivered!.segments[0]!.facts!;
    expect(facts.route).toBe('scheduled');
    expect(delivered!.body).toBe('remind them to drink water');
    // 是哪一条:标题在信封自己那一格(人看的投递卡上也写它),❌ 再在上下文那句里说一遍。
    expect(facts.schedule).toBe('remind them to drink water');
    expect(facts.messageContext).not.toContain('"remind them');
    expect(facts.messageContext).toContain(`schedule:${id}`);
    expect(facts.messageContext).toContain('due 2026-10-15 06:03 Asia/Shanghai, one-time');

    expect(keeperNextDue()).toBeNull();
    const listed = (await runAgentScheduleAction(AGENT, { action: 'schedule_list' })) as { schedules: Array<Record<string, unknown>> };
    expect(listed.schedules[0]).toMatchObject({ active: false, next_run_at: null, last_run: { status: 'done' } });
  });

  it('重复的:送完照常预排下一次', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'agenda', cron: '0 8 * * *', tz: 'Asia/Shanghai' });
    vi.setSystemTime(Date.UTC(2026, 9, 15, 0, 0, 30));
    const record = recordingCallbacks();
    await new AutomationScheduler(record.callbacks).reload();
    await record.when(() => record.steps.some((run) => run.status === 'done'));
    await record.when(() => keeperNextDue() === Date.UTC(2026, 9, 16, 0, 0, 0));
    expect((await getAutomation(scheduleIdOf(created)))?.enabled).toBe(true);
  });

  it.each([
    ['归档', () => fixture.sqlite.prepare(`UPDATE sessions SET archived_at = '2026-10-15T06:01:00Z' WHERE id = ?`).run(AGENT.sessionId)],
    ['删除', () => fixture.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(AGENT.sessionId)],
  ])('建它的会话被%s:这次记失败、写明 agent 已不在,❌ 悄悄吞掉也 ❌ 送到别处', async (_label, remove) => {
    const { id, run } = await dueOneTimeRun();
    remove();
    const automation = (await getAutomation(id))!;
    expect(automation.agentSession).toEqual({ name: _label === '删除' ? null : '个人助理', gone: true });

    const started = await insertRun({
      automationId: id,
      triggerConfigSnapshot: run.triggerConfigSnapshot,
      agentConfigSnapshot: run.agentConfigSnapshot,
      scheduledAt: run.scheduledAt,
      status: 'creating_session',
      triggerKind: 'cron',
      startedAt: Date.now(),
    });
    // 默认的那一套:会话在不在读真库,送走的那一头是记录器。
    const result = await executeAgentDelivery(automation, started, () => {});

    expect(result.success).toBe(false);
    expect(mocks.messageSessionFrom).not.toHaveBeenCalled();
    const stored = fixture.sqlite.prepare('SELECT status, error FROM automation_runs WHERE id = ?').get(started.id) as { status: string; error: string };
    expect(stored.status).toBe('failed');
    expect(JSON.parse(stored.error)).toMatchObject({ step: 'deliver', code: 'agent_gone' });
  });

  it('送不到(恢复失败等)记失败,带上原因', async () => {
    const { id } = await dueOneTimeRun();
    mocks.messageSessionFrom.mockRejectedValueOnce(new Error('SESSION_DIRECT_NOT_LIVE: could not resume'));
    const record = recordingCallbacks();
    await new AutomationScheduler(record.callbacks).reload();
    await record.when(() => record.steps.some((run) => run.status === 'failed'));
    const failed = record.steps.find((run) => run.status === 'failed')!;
    expect(failed.automationId).toBe(id);
    expect(failed.error).toEqual({ step: 'deliver', code: 'delivery_failed', message: 'SESSION_DIRECT_NOT_LIVE: could not resume' });
  });

  it('keeps a refused scheduled reminder enabled and retries once on a later queue drain', async () => {
    const { id } = await dueOneTimeRun();
    mocks.messageSessionFrom.mockRejectedValue(Object.assign(new Error('not admitted'), { code: 'SESSION_DIRECT_NOT_LIVE' }));
    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks);
    await scheduler.reload();
    await record.when(() => record.steps.some(row => row.status === 'queued'));
    await new Promise(resolve => setTimeout(resolve,50));
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    expect(fixture.sqlite.prepare('SELECT enabled FROM automations WHERE id=?').pluck().get(id)).toBe(1);
    expect(fixture.sqlite.prepare("SELECT status FROM automation_runs WHERE automation_id=? AND status <> 'scheduled'").pluck().get(id)).toBe('queued');
    mocks.messageSessionFrom.mockResolvedValue({ id: 'accepted' });
    vi.setSystemTime(Date.now() + 2000);
    await scheduler.drainQueue();
    await record.when(() => record.steps.some(row => row.status === 'done'));
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(2);
    expect(mocks.messageSessionFrom.mock.calls[0]![3].receipt).toEqual(mocks.messageSessionFrom.mock.calls[1]![3].receipt);
  });

  it('keeps a reminder queued after a definite refusal and reuses its delivery identity on retry', async () => {
    const { id,run } = await dueOneTimeRun();
    const automation = (await getAutomation(id))!;
    const started = await insertRun({ automationId: id,triggerConfigSnapshot: run.triggerConfigSnapshot,
      agentConfigSnapshot: run.agentConfigSnapshot,scheduledAt: run.scheduledAt,status: 'creating_session',triggerKind: 'cron',startedAt: Date.now() });
    const deliver = vi.fn().mockRejectedValueOnce(Object.assign(new Error('面板状态暂时不可用。'),{ code: 'SESSION_DIRECT_NOT_LIVE' }))
      .mockResolvedValue({ id: 'native-admitted' });
    const deps = { sessionPresent: async () => true,deliver };
    expect((await executeAgentDelivery(automation,started,() => {},deps)).success).toBe(false);
    expect(fixture.sqlite.prepare('SELECT status, finished_at FROM automation_runs WHERE id=?').get(started.id)).toMatchObject({ status: 'queued',finished_at: null });
    expect((await executeAgentDelivery(automation,started,() => {},deps)).success).toBe(true);
    expect(deliver.mock.calls[0]![4]).toEqual(deliver.mock.calls[1]![4]);
    expect(deliver.mock.calls[0]![4]).toMatchObject({ id: started.id });
  });
});

// code review 两条:一次性只在 runWorker 的 finally 里关,别的终局(重启打断、被挤掉)会留下一条开着却不再响的;
// 过了时间的一次性在界面上还能被重新打开。
describe('一次性过了那一刻就收口', () => {
  async function oneTime(at = '2026-10-15T06:03'): Promise<string> {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'p', at, tz: 'Asia/Shanghai' });
    return scheduleIdOf(created);
  }
  const enabledOf = (id: string) => fixture.sqlite.prepare('SELECT enabled FROM automations WHERE id = ?').pluck().get(id);

  it('还有排着的那一次时不关(它还要靠开着才会被调度);过了那一刻、运行都走完了才关', async () => {
    const id = await oneTime();
    expect(await closeSpentOneTimeAutomation(id, NOW)).toBe(false); // 还没到
    expect(await closeSpentOneTimeAutomation(id, NOW + 5 * 60_000)).toBe(false); // 到了,但到点那次还排着
    fixture.sqlite.prepare(`UPDATE automation_runs SET status = 'skipped' WHERE automation_id = ?`).run(id); // 被挤掉
    expect(await closeSpentOneTimeAutomation(id, NOW + 5 * 60_000)).toBe(true);
    expect(enabledOf(id)).toBe(0);
  });

  it('送到一半应用退出:重启时那次记 interrupted_by_restart,这条一次性随之关掉', async () => {
    const id = await oneTime();
    vi.setSystemTime(NOW + 4 * 60_000);
    fixture.sqlite
      .prepare(`UPDATE automation_runs SET status = 'creating_session', started_at = ? WHERE automation_id = ?`)
      .run(NOW + 3 * 60_000, id);
    const record = recordingCallbacks();
    const scheduler = new AutomationScheduler(record.callbacks);
    scheduler.start();
    await record.when(() => enabledOf(id) === 0);
    scheduler.stop();
    expect(record.steps.find((run) => run.automationId === id)?.error).toMatchObject({ code: 'interrupted_by_restart' });
    expect(keeperNextDue()).toBeNull();
  });

  it('开机自愈:开着、过了时间、什么运行都没有的一次性,启动时关掉', async () => {
    const id = await oneTime();
    fixture.sqlite.prepare('DELETE FROM automation_runs WHERE automation_id = ?').run(id);
    vi.setSystemTime(NOW + 10 * 60_000);
    const record = recordingCallbacks();
    await new AutomationScheduler(record.callbacks).reload();
    expect(enabledOf(id)).toBe(0);
  });

  it('过了时间的一次性不能被重新打开(否则列表显示开着、它永远不来);没到时间的照常能停能开', async () => {
    const id = await oneTime();
    await service.setAutomationEnabled(id, false);
    await service.setAutomationEnabled(id, true);
    expect(enabledOf(id)).toBe(1);
    await service.setAutomationEnabled(id, false);
    vi.setSystemTime(NOW + 10 * 60_000);
    await expect(service.setAutomationEnabled(id, true)).rejects.toThrow('schedule_time_passed');
    expect(enabledOf(id)).toBe(0);
  });
});

// #7199 助理搬家:旧家那台上它排的「已安排」,在新家那台、它那条会话上重排。
describe('restoreAgentSchedules(搬家重排)', () => {
  const TARGET = AGENT;

  it('重复的与一次性未到点的重排到新会话上;管家的「下一次到期」查询读得到;关着的保持关着', async () => {
    const result = await restoreAgentSchedules(TARGET, [
      { name: '早报', prompt: '读今天的日程,发给主人', triggerConfig: { expr: '0 8 * * *', tz: 'Asia/Shanghai' }, enabled: true },
      { name: '喝水', prompt: '提醒喝水', triggerConfig: { expr: '', tz: 'Asia/Shanghai', at: NOW + 3 * 60_000 }, enabled: true },
      { name: '暂停的', prompt: '周报', triggerConfig: { expr: '0 17 * * 5', tz: 'Asia/Shanghai' }, enabled: false },
    ]);

    expect(result).toEqual({ restored: 3, skipped: [] });
    const listed = (await runAgentScheduleAction(TARGET, { action: 'schedule_list' })) as {
      schedules: Array<{ title: string; active: boolean }>;
    };
    expect(listed.schedules.map((row) => `${row.title}:${row.active}`)).toEqual(['早报:true', '喝水:true', '暂停的:false']);
    expect(keeperNextDue()).toBe(NOW + 3 * 60_000);
  });

  it('幂等:同一批再来一次不翻倍;已过点的一次性不排并说出来', async () => {
    const batch = [
      { name: '早报', prompt: '读今天的日程', triggerConfig: { expr: '0 8 * * *', tz: 'Asia/Shanghai' }, enabled: true },
      { name: '过期的', prompt: '昨天的提醒', triggerConfig: { expr: '', tz: 'Asia/Shanghai', at: NOW - 60_000 }, enabled: true },
    ];
    expect(await restoreAgentSchedules(TARGET, batch)).toEqual({
      restored: 1,
      skipped: [{ name: '过期的', reason: 'never-fires' }],
    });
    expect(await restoreAgentSchedules(TARGET, batch)).toEqual({
      restored: 0,
      skipped: [
        { name: '早报', reason: 'exists' },
        { name: '过期的', reason: 'never-fires' },
      ],
    });
    const listed = (await runAgentScheduleAction(TARGET, { action: 'schedule_list' })) as { schedules: unknown[] };
    expect(listed.schedules).toHaveLength(1);
  });

  it('只排在目标会话上,不碰同机别的会话已有的', async () => {
    await runAgentScheduleAction(OTHER, { action: 'schedule_create', prompt: '读今天的日程', cron: '0 8 * * *', tz: 'Asia/Shanghai' });
    const result = await restoreAgentSchedules(TARGET, [
      { name: '早报', prompt: '读今天的日程', triggerConfig: { expr: '0 8 * * *', tz: 'Asia/Shanghai' }, enabled: true },
    ]);
    expect(result.restored).toBe(1);
  });
});

describe('人动了它排的那条,告诉它(owner 10-19 B)', () => {
  it('存下来不叫醒(defer),同一条只留最后一句;信封是咕咕系统的通知,带 schedule id', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'look at CI', title: '检查 CI 结果', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    const automation = (await getAutomation(scheduleIdOf(created)))!;
    await tellAgentScheduleChanged({ kind: 'rescheduled', automation, nextRunAt: Date.UTC(2026, 9, 15, 1, 0, 0) });

    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    const [envelope, sessionId, text, options] = mocks.messageSessionFrom.mock.calls[0]!;
    expect(sessionId).toBe(AGENT.sessionId);
    expect(options).toEqual({ keyScope: `automation:${automation.id}`, delivery: 'defer', key: 'changed' });
    expect(text).toContain(`schedule:${automation.id}`);
    expect(text).toContain('检查 CI 结果');
    expect(text).toContain('2026-10-15 07:00 Asia/Shanghai');
    const facts = readDeliveryEnvelope((envelope as (messageId: string, said: string) => string)('m-1', text as string))!.segments[0]!.facts!;
    expect(facts).toMatchObject({ route: 'system', fromId: 'system:gugu' });

    expect(agentScheduleChangeText({ kind: 'cancelled', automation })).toMatch(/cancelled your schedule "检查 CI 结果".*will not come back/);
  });

  it('人那条路(控制器)取消还会响的那条才告诉它;过了点没送到的「不用了」、agent 自己 schedule_cancel 都不告诉', async () => {
    const { automationsController } = await import('./controller');
    const pending = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'p', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    await automationsController.deleteAutomation(scheduleIdOf(pending));
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    expect(mocks.messageSessionFrom.mock.calls[0]![2]).toContain('cancelled');

    const spent = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 's', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    fixture.sqlite.prepare('UPDATE automations SET enabled = 0 WHERE id = ?').run(scheduleIdOf(spent));
    await automationsController.deleteAutomation(scheduleIdOf(spent));
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);

    const own = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'o', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    await runAgentScheduleAction(AGENT, { action: 'schedule_cancel', schedule_id: (own as { schedule_id: string }).schedule_id });
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
  });

  it('控制器:原样保存不算改,不说;停掉 / 重新打开各说一句', async () => {
    const { automationsController } = await import('./controller');
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'p', cron: '0 8 * * *', tz: 'Asia/Shanghai' });
    const id = scheduleIdOf(created);
    await automationsController.updateAutomationSettings(id, { triggerConfig: { expr: '0 8 * * *', tz: 'Asia/Shanghai' } });
    expect(mocks.messageSessionFrom).not.toHaveBeenCalled();

    await automationsController.setAutomationEnabled(id, false);
    expect(mocks.messageSessionFrom.mock.calls.at(-1)![2]).toMatch(/paused your schedule/);
    // 停着的时候改时间:它本来就不指望回来,不说。
    await automationsController.updateAutomationSettings(id, { triggerConfig: { expr: '0 9 * * *', tz: 'Asia/Shanghai' } });
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    await automationsController.toggleAutomationEnabled(id, true);
    expect(mocks.messageSessionFrom.mock.calls.at(-1)![2]).toMatch(/turned your schedule .* back on; next 2026-10-15 09:00 Asia\/Shanghai/);
    // 同一个值再设一遍(没变)不说。
    await automationsController.setAutomationEnabled(id, true);
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(2);
  });

  it('改时间的时区要认得', async () => {
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'p', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    await expect(
      service.updateAutomationSettings(scheduleIdOf(created), { triggerConfig: { expr: '', tz: 'Mars/Olympus', at: NOW + 3600_000 } })
    ).rejects.toThrow(/unknown time zone/);
  });

  it('控制器改时间:改成了再告诉它,带新的那一刻', async () => {
    const { automationsController } = await import('./controller');
    const created = await runAgentScheduleAction(AGENT, { action: 'schedule_create', prompt: 'p', at: '2026-10-15T07:00', tz: 'Asia/Shanghai' });
    await automationsController.updateAutomationSettings(scheduleIdOf(created), { triggerConfig: { expr: '', tz: 'Asia/Shanghai', at: Date.UTC(2026, 9, 15, 2, 0, 0) } });
    expect(mocks.messageSessionFrom).toHaveBeenCalledTimes(1);
    expect(mocks.messageSessionFrom.mock.calls[0]![2]).toContain('moved your schedule');
    expect(mocks.messageSessionFrom.mock.calls[0]![2]).toContain('2026-10-15 10:00 Asia/Shanghai');
  });
});
