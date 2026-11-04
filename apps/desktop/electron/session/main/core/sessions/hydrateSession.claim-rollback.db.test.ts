import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

// hydrate 在 spawn **之前**写 provider_session_id,那是挡并发重复 spawn 的幂等闸 —— 它记的是
// 「我认领了这次启动」,不是「已经启动成功」。启动失败却不退账,这条会话就永远停在
// 「已记账、从没真起来」:下一次打开按 isResuming 走,跳过 fresh 启动路径该做的准备,
// 从此打不开,而提示词明明还躺在 config 里。
//
// 真机上撞到过:codex 是 `#!/usr/bin/env node` 脚本,GUI 起的 app PATH 里没有 node,
// 一次启动失败就把四条会话变成砖,后续报错离真因两级远。

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  startSession: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('../projects/utils', () => ({
  resolveSession: () => ({ sessions: { startSession: mocks.startSession } }),
}));
vi.mock('@main/lib/events', () => ({
  events: { emit: mocks.emit },
}));

import { hydrateSession } from './hydrateSession';

const providerSessionIdOf = (fixture: Awaited<ReturnType<typeof openFixture>>, id: string) =>
  (
    fixture.sqlite.prepare('SELECT provider_session_id FROM sessions WHERE id = ?').get(id) as
      | { provider_session_id: string | null }
      | undefined
  )?.provider_session_id ?? null;

const providerSessionStateOf = (fixture: Awaited<ReturnType<typeof openFixture>>, id: string) => {
  const row = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as
    | { config: string }
    | undefined;
  return row
    ? (JSON.parse(row.config) as { providerSessionState?: string }).providerSessionState
    : undefined;
};

describe('hydrateSession 的启动认领', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    mocks.startSession.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('fresh', 'project-1', 'codex', 'pty',
                '{"version":"1","type":"pty","agentDisplayName":"hi","initialPrompt":"hi"}');
      INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
        VALUES ('started', 'project-1', 'codex', 'pty',
                '{"version":"1","type":"pty","agentDisplayName":"hi2","initialPrompt":"hi2"}', 'started');
      INSERT INTO sessions (id, project_id, provider, runtime, config, provider_session_id)
        VALUES ('dangling', 'project-1', 'codex', 'pty',
                '{"version":"1","type":"pty","agentDisplayName":"lost","initialPrompt":"lost"}',
                '00000000-0000-4000-8000-000000000369');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('第一次启动失败后退账,下一次仍是「首次启动」并带着初始提示词', async () => {
    mocks.startSession.mockRejectedValueOnce(new Error('codex app-server 起不来'));

    await expect(hydrateSession('project-1', 'fresh')).rejects.toThrow(
      'codex app-server 起不来'
    );

    // 退账了 —— 否则这条会话就是砖。
    expect(providerSessionIdOf(fixture, 'fresh')).toBeNull();

    // 而且下一次真的按首次启动走:isResuming=false,且把提示词带下去。
    mocks.startSession.mockResolvedValueOnce(undefined);
    await hydrateSession('project-1', 'fresh');
    const [, , isResuming, initialPrompt] = mocks.startSession.mock.calls.at(-1) ?? [];
    expect(isResuming).toBe(false);
    expect(initialPrompt).toBe('hi');
  });

  it('启动成功就保住认领(幂等闸不能因为这次修复失效)', async () => {
    mocks.startSession.mockResolvedValueOnce(undefined);

    await hydrateSession('project-1', 'fresh');

    expect(providerSessionIdOf(fixture, 'fresh')).toBe('fresh');
  });

  // #5869 —— 认领与退账都必须**说出来**。渲染进程手里也留着一份 provider_session_id,而它正是
  // 「切到通用模式要续哪条 provider 会话」的入参来源;只写库不广播,渲染端就会一直是空的,
  // 于是切换时递出 null ⇒ runtime 走 session/new ⇒ 这条会话的历史被悄悄换掉。
  //
  // 双向:成功要广播**那个 id**,失败要广播**清空**。少任何一半,渲染端都会停在一句谎话上。
  it('认领与退账都广播给渲染端(双向)', async () => {
    const providerSessionIdChanges = () =>
      mocks.emit.mock.calls
        .map(([, payload]) => payload as { sessionId: string; changes: Record<string, unknown> })
        .filter((payload) => payload.sessionId === 'fresh' && 'providerSessionId' in payload.changes)
        .map((payload) => payload.changes.providerSessionId);

    mocks.startSession.mockResolvedValueOnce(undefined);
    await hydrateSession('project-1', 'fresh');
    expect(providerSessionIdChanges()).toEqual(['fresh']);

    // 阳控:同一把尺子在退账那一侧也要动 —— 只测成功那半,回归时它照样全绿。
    mocks.emit.mockReset();
    fixture.sqlite.prepare('UPDATE sessions SET provider_session_id = NULL WHERE id = ?').run('fresh');
    mocks.startSession.mockRejectedValueOnce(new Error('boom'));
    await expect(hydrateSession('project-1', 'fresh')).rejects.toThrow('boom');
    expect(providerSessionIdChanges()).toEqual(['fresh', null]);
  });

  it('恢复既有会话时失败,不动它原来的 provider_session_id', async () => {
    mocks.startSession.mockRejectedValueOnce(new Error('boom'));

    await expect(hydrateSession('project-1', 'started')).rejects.toThrow('boom');

    // 退的只该是**这次**认领的那笔;别人的账不能碰,否则会把一条真起来过的会话
    // 降级成「首次启动」,resume 语义就丢了。
    expect(providerSessionIdOf(fixture, 'started')).toBe('started');
    expect(providerSessionStateOf(fixture, 'started')).toBeUndefined();
  });

  it('provider 会话精确缺失时持久标记,保留原 id,再次打开不重试启动', async () => {
    const missing = Object.assign(
      new Error('no rollout found for thread id 00000000-0000-4000-8000-000000000369'),
      { code: -32600 }
    );
    mocks.startSession.mockRejectedValueOnce(missing);

    await expect(hydrateSession('project-1', 'dangling')).resolves.toBeUndefined();
    expect(providerSessionIdOf(fixture, 'dangling')).toBe('00000000-0000-4000-8000-000000000369');
    expect(providerSessionStateOf(fixture, 'dangling')).toBe('missing');
    expect(mocks.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sessionId: 'dangling',
        changes: { providerSessionState: 'missing' },
      })
    );
    expect(mocks.startSession).toHaveBeenCalledTimes(1);

    await expect(hydrateSession('project-1', 'dangling')).resolves.toBeUndefined();
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
  });
});
