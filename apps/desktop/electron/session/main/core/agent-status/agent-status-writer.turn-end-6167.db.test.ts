import { openFixture } from '@tooling/utils/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusWritesSettled } from './_support/status-writes-settled';
import type { AppDb } from '@main/db/client';
import type { AgentEvent, NotificationType } from '@shared/core/agents/agentEvents';

/**
 * #6167 —— 「做完未读」= idle + 未 seen。completed 并进 idle 之后,「是不是刚做完」不能再靠状态值分,
 * 只能靠边的来源:seen=0 与完成提示音**只由回合结束那条边**(在跑的会话收到 stop)写出。
 * 其余到达 idle 的路径 —— Claude 做完一分钟后的 idle_prompt、没在跑时的 stop、跑着时的 idle_prompt ——
 * 都不许把一条什么都没做完的会话标成「做完未读」。
 *
 * 判据打在真 SQLite 上,读会话行的 agent_status / agent_status_seen(侧栏「做完未读」读的就是这两列)。
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

vi.mock('@main/core/pty/controller', () => ({ ptyController: { interrupt: vi.fn() } }));

const { agentHookService } = await import('../agent-hooks/agent-hook-service');
const { agentStatusWriter } = await import('./agent-status-writer');
const { interruptTuiTurn } = await import('@main/core/sessions/interrupt-tui-turn');

let clock = 1_000;
// 宿主的内存观测按会话 id 留着 ⇒ 每格一个新会话 id,格与格互不继承。
let cid = 'c0';
function event(type: AgentEvent['type'], notificationType?: NotificationType): AgentEvent {
  clock += 1;
  return {
    type,
    providerId: 'claude',
    projectId: 'p1',
    sessionId: cid,
    timestamp: clock,
    payload: notificationType ? { notificationType } : {},
  };
}

describe('#6167 做完未读只由回合结束那条边写出', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const statuses: string[] = [];
  let off: () => void = () => {};

  const row = () =>
    fixture.sqlite
      .prepare(`SELECT agent_status AS status, agent_status_seen AS seen FROM sessions WHERE id = ?`)
      .get(cid) as { status: string; seen: number };
  /** 送一条事件并等宿主把它写完(以 'agent:status' 播出为完成信号)。 */
  const deliver = async (e: AgentEvent) => {
    const before = statuses.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(statuses.length).toBe(before + 1);
  };
  /** 送一条**不该产生任何写入**的事件:等处理跑完,再证明它确实没播。 */
  const deliverNoop = async (e: AgentEvent) => {
    const before = statuses.length;
    agentHookService.emitAgentEvent(e);
    await statusWritesSettled(agentStatusWriter, e.sessionId);
    expect(statuses.length, `${e.type}/${String(e.payload.notificationType)} must not write a status`).toBe(before);
  };

  beforeAll(async () => {
    await agentHookService.initialize();
    agentStatusWriter.initialize();
  });
  afterAll(() => {
    agentStatusWriter.dispose();
    agentHookService.dispose();
  });

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    cid = `c${clock}`;
    statuses.length = 0;
    fixture.sqlite.prepare(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo')`).run();
    // 会话出生:idle + 已读(build-session-row 的口径)。
    fixture.sqlite
      .prepare(
        `INSERT INTO sessions (id, project_id, provider, runtime, agent_status, agent_status_seen)
         VALUES (?, 'p1', 'claude', 'pty', 'idle', 1)`
      )
      .run(cid);
    off = agentStatusWriter.on('agent:status', ({ reading }) => {
      statuses.push(reading.status);
    });
  });

  afterEach(async () => {
    off();
    fixture.close();
    mocks.db = undefined;
  });

  it('在跑的会话收到 stop ⇒ idle + 未读、完成音;一分钟后的 idle_prompt 什么都不改', async () => {
    await deliver(event('start'));
    expect(row()).toEqual({ status: 'working', seen: 1 });

    await deliver(event('stop'));
    expect(row()).toEqual({ status: 'idle', seen: 0 });

    // Claude Code 闲置约 60 秒发的「waiting for your input」:不是新事实。
    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row(), '做完未读不能被它清成已读').toEqual({ status: 'idle', seen: 0 });
  });

  it('阴控:没在跑时的 stop 不是回合结束 ⇒ 不写未读、不响', async () => {
    await deliverNoop(event('stop'));
    expect(row()).toEqual({ status: 'idle', seen: 1 });
  });

  it('阴控:跑着时来的 idle_prompt 回到 idle 但不是「做完」⇒ 已读、不响', async () => {
    await deliver(event('start'));
    await deliver(event('notification', 'idle_prompt'));
    expect(row()).toEqual({ status: 'idle', seen: 1 });
  });

  it('失败的回合一分钟后的 idle_prompt 不抹掉 error(等批准同理)', async () => {
    await deliver(event('start'));
    await deliver(event('error'));
    expect(row()).toEqual({ status: 'error', seen: 0 });
    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row(), '回合失败不能一分钟后无声变成空闲').toEqual({ status: 'error', seen: 0 });

    await deliver(event('start'));
    await deliver(event('notification', 'permission_prompt'));
    await deliverNoop(event('notification', 'idle_prompt'));
    expect(row()).toEqual({ status: 'needs_user', seen: 0 });
  });

  it('等批准进入「需要你」且未读;批准后回到 working 已读', async () => {
    await deliver(event('start'));
    await deliver(event('notification', 'permission_prompt'));
    expect(row()).toEqual({ status: 'needs_user', seen: 0 });

    await deliver(event('wait_resolved'));
    expect(row()).toEqual({ status: 'working', seen: 1 });
  });

  it('跑着时用户点 Stop(会话退出)⇒ idle 已读', async () => {
    await deliver(event('start'));
    await agentStatusWriter.settleSessionExited({ sessionId: cid, projectId: 'p1' });
    expect(row()).toEqual({ status: 'idle', seen: 1 });
  });

  it('宿主发出的中断(终端腿按键位写进 pty)⇒ 宿主自己收成 idle 已读;被打断不发 hook 的家不会停在 working', async () => {
    await deliver(event('start'));
    expect(row().status).toBe('working');
    const interrupt = vi.fn(async () => ({ success: true as const, data: undefined }));
    await expect(
      interruptTuiTurn(
        { id: cid, projectId: 'p1' },
        { interrupt, markInterrupted: (params) => agentStatusWriter.interrupt(params) },
      ),
    ).resolves.toBe(true);
    expect(interrupt).toHaveBeenCalledWith(`p1:${cid}:${cid}`);
    expect(row(), '打断不是做完:已读、不进托盘').toEqual({ status: 'idle', seen: 1 });
    // 会发 Stop 的家:迟到的 stop 看到的已经不在跑 ⇒ 同样不写「做完未读」
    await deliverNoop(event('stop'));
    expect(row()).toEqual({ status: 'idle', seen: 1 });
  });

  it('阴控:中断键没写出去(没有这条 pty)⇒ 状态原样,不替它收', async () => {
    await deliver(event('start'));
    const interrupt = vi.fn(async () => ({ success: false as const, error: { type: 'not_found' as const } }));
    await expect(
      interruptTuiTurn(
        { id: cid, projectId: 'p1' },
        { interrupt: interrupt as never, markInterrupted: (params) => agentStatusWriter.interrupt(params) },
      ),
    ).resolves.toBe(false);
    expect(row().status).toBe('working');
  });
});
