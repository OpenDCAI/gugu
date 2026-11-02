import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

// spec session-runtime-switch:同一条会话换一种展示重开。
//
// 这里守三件在真机上最容易变成「半切状态」的事:
//  ① 顺序 —— 闸在停之前、停在改记录之前。闸放在后面,一条这家根本没有的腿会先把活着的那条停掉;
//     改记录放在停之前,dehydrate 读到的已经是新的 runtime,它会当场提前返回,伪终端留着不死。
//  ② provider 会话 id 一个字节都不动 —— 它是「这仍是同一条会话」的唯一凭据。
//  ③ 死掉那条腿的字段不许跟着过去(端点、起进程时带的 MCP 快照、首轮载荷)。

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  /** session-life's stop of the ACP leg, and where its run ends up (failed = it could not be stopped). */
  stopSession: vi.fn(),
  lifeKind: 'dormant' as 'dormant' | 'failed',
  detachSession: vi.fn(),
  surfaces: ['tui', 'acp'] as string[],
  sessionpage: {
    'tui': { identity: 'addressable', messageTransport: 'router' },
    'acp': { identity: 'addressable', messageTransport: 'router' },
  } as Record<string, unknown>,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./session-life', () => ({ sessionLife: () => ({
  interrupt: async (sessionId: string, event: { reason: string }) => { mocks.stopSession({ sessionId, reason: event.reason }); },
  read: () => ({ kind: mocks.lifeKind }),
}) }));
vi.mock('@main/core/agents/plugin-registry', () => ({
  getPlugin: () => ({
    capabilities: {
      sessionBundle: { surfaces: mocks.surfaces, sessionpage: mocks.sessionpage },
    },
  }),
}));
vi.mock('../projects/utils', () => ({
  resolveSession: () => ({ sessions: { detachSession: mocks.detachSession } }),
}));

import { switchSessionRuntime } from './switch-session-runtime';

type Fixture = Awaited<ReturnType<typeof openFixture>>;

const rowOf = (fixture: Fixture, id: string) =>
  fixture.sqlite.prepare('SELECT runtime, provider_session_id, config FROM sessions WHERE id = ?').get(id) as
    | { runtime: string | null; provider_session_id: string | null; config: string }
    | undefined;

const configOf = (fixture: Fixture, id: string) =>
  JSON.parse(rowOf(fixture, id)?.config ?? '{}') as Record<string, unknown>;

describe('switchSessionRuntime', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    mocks.stopSession.mockReset();
    mocks.lifeKind = 'dormant';
    mocks.detachSession.mockReset();
    mocks.surfaces = ['tui', 'acp'];
    mocks.sessionpage = {
      'tui': { identity: 'addressable', messageTransport: 'router' },
      'acp': { identity: 'addressable', messageTransport: 'router' },
    };
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
        VALUES ('chat', 'project-1', 'claude', 'acp',
                '{"version":"1","type":"acp","model":"claude-sonnet-5","initialQueue":[{"text":"hi"}],' ||
                '"mcpDisabledServers":["a"],"mcpToggleDecided":true,"mcpSessionServers":["b"],' ||
                '"firstUtterance":"hi"}',
                'provider-session-1');
      INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
        VALUES ('term', 'project-1', 'claude', 'pty',
                '{"version":"1","type":"pty","model":"claude-sonnet-5","initialPrompt":"yo",' ||
                '"providerSessionEndpoint":"http://127.0.0.1:1234/","firstUtterance":"yo"}',
                'provider-session-2');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('通用 → 编程:停掉适配器、改记录、provider 会话 id 不动', async () => {
    await switchSessionRuntime('project-1', 'chat', 'pty');

    expect(mocks.stopSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'chat', reason: 'reconfigure' });
    const row = rowOf(fixture, 'chat');
    expect(row?.runtime).toBe('pty');
    // 同一条会话的唯一凭据:换腿不换它。
    expect(row?.provider_session_id).toBe('provider-session-1');
    const config = configOf(fixture, 'chat');
    expect(config.type).toBe('pty');
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.firstUtterance).toBe('hi');
    // 死掉那条腿的东西不许跟过去。
    expect(config.initialQueue).toBeUndefined();
    expect(config.mcpSessionServers).toBeUndefined();
    // 这个 id 是 ACP 适配器铸的 —— 记下来历,编程腿才知道要用它 `--resume`,
    // 而不是回落到 conversation.id(那条会话在引擎侧根本不存在)。
    expect(config.providerMintedSessionId).toBe(true);
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: 'chat', changes: { runtime: 'pty' } })
    );
  });

  it('编程 → 通用:摘掉伪终端,并丢掉那个进程的控制端点', async () => {
    await switchSessionRuntime('project-1', 'term', 'acp');

    expect(mocks.detachSession).toHaveBeenCalledExactlyOnceWith('term');
    const row = rowOf(fixture, 'term');
    expect(row?.runtime).toBe('acp');
    expect(row?.provider_session_id).toBe('provider-session-2');
    const config = configOf(fixture, 'term');
    expect(config.type).toBe('acp');
    // 反向没有这条来历:编程腿的 id 本来就是咕咕铸的,通用腿直接拿 provider_session_id 去 load。
    expect(config.providerMintedSessionId).toBeUndefined();
    // 端点属于那个已经没了的 TUI 进程;留着就是一条死链。
    expect(config.providerSessionEndpoint).toBeUndefined();
    expect(config.initialPrompt).toBeUndefined();
  });

  it('目标就是当前那一种:抛,并且**一条腿都不停**', async () => {
    await expect(switchSessionRuntime('project-1', 'chat', 'acp')).rejects.toThrow(
      /已经是 acp/
    );

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(mocks.detachSession).not.toHaveBeenCalled();
    expect(rowOf(fixture, 'chat')?.runtime).toBe('acp');
  });

  // 闸必须在停之前:否则一条这家根本没有的腿,会先把用户正在用的那条停掉再报错 ——
  // 用户点了一个「切不过去」的菜单项,代价是当前这条会话也没了。
  it('这一家没有目标那条腿:抛,活着的那条腿不受影响', async () => {
    mocks.surfaces = ['acp'];
    mocks.sessionpage = { 'acp': { identity: 'addressable', messageTransport: 'router' } };

    await expect(switchSessionRuntime('project-1', 'chat', 'pty')).rejects.toThrow(
      /tui/
    );

    expect(mocks.stopSession).not.toHaveBeenCalled();
    expect(rowOf(fixture, 'chat')?.runtime).toBe('acp');
    expect(configOf(fixture, 'chat').type).toBe('acp');
  });

  // 停不掉就不改记录:改了的话,记录说自己在另一条腿上,而旧进程还活着写着同一条 provider 会话。
  it('停不掉当前那条腿:记录一个字节都不改', async () => {
    mocks.lifeKind = 'failed';

    await expect(switchSessionRuntime('project-1', 'chat', 'pty')).rejects.toThrow('could not be stopped');

    expect(rowOf(fixture, 'chat')?.runtime).toBe('acp');
    expect(configOf(fixture, 'chat').type).toBe('acp');
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
