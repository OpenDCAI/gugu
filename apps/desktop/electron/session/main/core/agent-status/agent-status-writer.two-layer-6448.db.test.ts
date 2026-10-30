import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent, NotificationType } from '@shared/core/agents/agentEvents';

/**
 * #6448 —— 状态写入者的两层输出:库里的基础态 + 附属态(`agent_status_detail`),进程内 'agent:status' 带出的功能布尔
 * (`running` / `background`)。序列照 claude 2.1.278 真 PTY 实测(2026-09-25,TUI hook 录制)。
 */
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('../agent-hooks/hook-server', () => ({
  HookServer: class {
    async start() {}
    stop() {}
    getPort() {
      return 0;
    }
    createSource(ptyId: string) {
      return { id: `source-${ptyId}`, token: 'token', dispose() {} };
    }
  },
}));
vi.mock('../agent-hooks/event-enricher', () => ({ parseHookEvent: vi.fn() }));
vi.mock('@main/core/sessions/set-session-id', () => ({ setProviderSessionId: vi.fn() }));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit, on: vi.fn(() => () => {}) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: vi.fn(() => ({ capabilities: { hooks: { kind: 'config', supportedEvents: ['start', 'stop', 'notification', 'error'] } }, behavior: {} })),
  isValidProviderId: vi.fn(() => true),
}));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');
const { setSessionAutoApproved } = await import('../agent-hooks/turn-autonomy');

let clock = 1_000;
// 宿主的内存观测按会话 id 留着 ⇒ 每格一个新会话 id,格与格互不继承。
let cid = 'c0';
function event(type: AgentEvent['type'], payload: AgentEvent['payload'] = {}): AgentEvent {
  clock += 1;
  return { type, providerId: 'claude', projectId: 'p1', sessionId: cid, timestamp: clock, payload };
}
const notification = (notificationType: NotificationType) => event('notification', { notificationType });


describe('#6448 基础态 + 附属态 + 功能布尔', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  type Output = { status: string; detail: string | null; running: boolean; background: string | null };
  const outputs: Output[] = [];
  let off: () => void = () => {};

  const row = () =>
    fixture.sqlite
      .prepare(
        `SELECT agent_status AS status, agent_status_detail AS detail, agent_status_seen AS seen FROM sessions WHERE id = ?`
      )
      .get(cid) as { status: string | null; detail: string | null; seen: number };
  const deliver = async (e: AgentEvent) => {
    const before = outputs.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(outputs.length).toBe(before + 1);
  };
  const deliverNoop = async (e: AgentEvent) => {
    const before = outputs.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(outputs.length, `${e.type} must not write a status`).toBe(before);
  };
  const ipcDetails = () =>
    mocks.emit.mock.calls
      .filter(([, payload]) => payload && 'reading' in payload && 'unseen' in payload)
      .map(([, payload]) => (payload as { reading: { detail: string | null } | null }).reading?.detail ?? null);

  beforeAll(async () => {
    await agentHookService.initialize();
    agentStatusWriter.initialize();
  });
  afterAll(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
  });

  const seed = (status: string | null, detail: string | null = null, runtime = 'pty') => {
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, title, provider, runtime, agent_status, agent_status_detail, agent_status_seen)
         VALUES (?, 'p1', 'C', 'claude', ?, ?, ?, 1)`
      )
      .run(cid, runtime, status, detail);
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    cid = `c${clock}`;
    outputs.length = 0;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    off = agentStatusWriter.on('agent:status', ({ reading }) => {
      outputs.push(reading);
    });
  });

  afterEach(async () => {
    off();
    setSessionAutoApproved(cid, false);
    fixture.close();
    mocks.db = undefined;
  });

  it('park:回合结束、后台在跑 ⇒ 库里 working/parked、已读、不响;输出 running=false background=running;通知轮结束才 idle/done', async () => {
    seed('idle');
    await deliver(event('start'));
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
    await deliver(event('stop', { backgroundTasks: 1, scheduledTasks: 0 }));
    expect(row()).toEqual({ status: 'working', detail: 'parked', seen: 1 });
    expect(outputs.at(-1)).toEqual({ status: 'working', detail: 'parked', running: false, background: 'running' });
    await deliverNoop(notification('idle_prompt'));
    await deliver(event('start'));
    await deliver(event('stop', { backgroundTasks: 0, scheduledTasks: 0 }));
    expect(row()).toEqual({ status: 'idle', detail: 'done', seen: 0 });
    expect(ipcDetails()).toEqual(['running', 'parked', 'running', 'done']);
  });

  it('bypass 下 AskUserQuestion 仍停下等人:needs_user/question、未读、响「要你」;作答后回到 working/running', async () => {
    seed('idle');
    setSessionAutoApproved(cid, true);
    await deliver(event('start'));
    await deliver(event('wait', { waitKind: 'question', waitId: 'toolu_q' }));
    expect(row()).toEqual({ status: 'needs_user', detail: 'question', seen: 0 });
    expect(outputs.at(-1)).toMatchObject({ running: true });
    await deliverNoop(notification('permission_prompt'));
    await deliver(event('wait_resolved', { waitId: 'toolu_q' }));
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
  });

  it('阴控:bypass 下的批准不等人 —— 同一条 permission_prompt 不写状态', async () => {
    seed('idle');
    setSessionAutoApproved(cid, true);
    await deliver(event('start'));
    await deliverNoop(notification('permission_prompt'));
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
  });

  it('工作区信任对话框(provider 阻塞)是会话级的 needs_user/dialog,不响;下一轮开始清掉', async () => {
    seed('idle');
    agentStatusWriter.reportProviderBlocker({
      sessionId: cid,
      projectId: 'p1',
      blocker: { kind: 'provider', reason: 'workspace-trust', message: 'Trust this folder?' },
    });
    await statusWritesSettled(agentStatusWriter, cid);
    expect(row()).toEqual({ status: 'needs_user', detail: 'dialog', seen: 0 });
    await deliver(event('start'));
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
  });

  it('agent 的提问(宿主问人)熬过 claude 回合中的 start、停下和下一轮开工,答了才收', async () => {
    seed('idle');
    const hostWait = async (open: boolean) => {
      agentStatusWriter.reportHostWait({ sessionId: cid, id: 'host-ask:agent-question:q1', open, waitKind: 'question' });
      await statusWritesSettled(agentStatusWriter, cid);
    };
    await deliver(event('start'));
    await hostWait(true);
    expect(row()).toEqual({ status: 'needs_user', detail: 'question', seen: 0 });
    // claude 的工具调用完了又报一次 start(接着跑了):那只了结它自己的等待。
    await deliverNoop(event('start'));
    await deliverNoop(event('stop'));
    await deliverNoop(event('start'));
    expect(row()).toMatchObject({ status: 'needs_user', detail: 'question' });
    await hostWait(false);
    expect(row()).toMatchObject({ status: 'working', detail: 'running' });
  });

  it('用户打断(取消的 stop)⇒ idle/plain、已读、不响', async () => {
    seed('idle');
    await deliver(event('start'));
    await deliver(event('stop', { outcome: 'cancelled' }));
    expect(row()).toEqual({ status: 'idle', detail: 'plain', seen: 1 });
  });

  it('日志由会话行恢复:行里是 needs_user,来一条 start 就接着往下走', async () => {
    seed('needs_user');
    await deliver(event('start'));
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
  });

  it('#6448 之前写下的 working 老行(附属态为空)照样由行恢复:回合结束落到 idle/done 未读', async () => {
    seed('working');
    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', detail: 'done', seen: 0 });
  });

  // 聊天页新建的 agent:会话行出生就是 working/running(列值与会话行同一笔事务落库)。进程内的读者(宿主按 agent 的流 →
  // 聊天页在线状态、注意力、用量、session_wait)只听 'agent:status' —— 出生不经写入者,首条 start 又因「读数没变」
  // 不播,它们就永远不知道它在跑。
  it('出生是一次写入:birth 把出生的 working 播给进程内读者;这一轮的 start 不重复,stop 照常收口', async () => {
    seed('working', 'running');
    const before = outputs.length;
    await agentStatusWriter.birth({
      id: cid,
      projectId: 'p1',
      agentStatus: 'working',
      agentStatusDetail: 'running',
    });
    expect(outputs.length).toBe(before + 1);
    expect(outputs.at(-1)).toEqual({ status: 'working', detail: 'running', running: true, background: null });
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
    await deliverNoop(event('start'));
    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', detail: 'done', seen: 0 });
  });

  it('重开也是出生:做完的会话重开 ⇒ 日志从 working/running 重新开始并播出,这一轮照常收口', async () => {
    seed('working');
    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', detail: 'done', seen: 0 });
    await agentStatusWriter.restart({ sessionId: cid, projectId: 'p1' });
    expect(outputs.at(-1)).toEqual({ status: 'working', detail: 'running', running: true, background: null });
    expect(row()).toEqual({ status: 'working', detail: 'running', seen: 1 });
    await deliverNoop(event('start'));
    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', detail: 'done', seen: 0 });
  });

  it('阴控:没有状态源的会话出生不写、不播', async () => {
    seed(null);
    await agentStatusWriter.birth({ id: cid, projectId: 'p1', agentStatus: null, agentStatusDetail: null });
    expect(outputs).toEqual([]);
    expect(row()).toEqual({ status: null, detail: null, seen: 1 });
  });

  it('阴控:idle 老行(附属态为空)来一条没在跑时的 stop,不写、不播', async () => {
    seed('idle');
    await deliverNoop(event('stop'));
    expect(row()).toEqual({ status: 'idle', detail: null, seen: 1 });
  });

  it('没有状态源的行(null)被打断不是一句新话 —— 仍是 null', async () => {
    seed(null);
    await agentStatusWriter.interrupt({ sessionId: cid });
    expect(row()).toEqual({ status: null, detail: null, seen: 1 });
  });
});
