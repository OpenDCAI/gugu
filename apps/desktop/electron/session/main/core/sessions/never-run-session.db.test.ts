import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { clearProviderSessionMissing } from './mark-provider-session-missing';
import { isResidentNeverRun, RESIDENT_AGENT_FIRST_UTTERANCE } from './never-run-session';

// #7223 「建来常驻、一句没聊过」= 没有已提交回合(session_turns)、也没有真首轮;起来之后陈旧的 missing 标记要去掉。
// 读写真库(迁移跑到最新)。

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));

let fixture: Awaited<ReturnType<typeof openFixture>>;

function seedSession(config: Record<string, unknown>, providerSessionId: string | null = 'gone'): void {
  fixture.sqlite
    .prepare(`INSERT INTO projects (id, name, path, created_at, updated_at) VALUES ('p', 'Home', '/home', 0, 0)`)
    .run();
  fixture.sqlite
    .prepare(`INSERT INTO sessions (id, project_id, provider, runtime, provider_session_id, config) VALUES ('s', 'p', 'claude', 'acp', ?, ?)`)
    .run(providerSessionId, JSON.stringify({ version: '1', type: 'acp', ...config }));
}

function seedTurn(): void {
  fixture.sqlite
    .prepare(`INSERT INTO session_turns (id, session_id, seq, turn_id, data) VALUES ('s:0', 's', 0, 't0', '{}')`)
    .run();
}

function config(): Record<string, unknown> {
  const row = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get('s') as { config: string };
  return JSON.parse(row.config) as Record<string, unknown>;
}

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.emit.mockReset();
});

afterEach(() => {
  fixture.close();
  mocks.db = undefined;
});

describe('isResidentNeverRun (#7223)', () => {
  it('建来常驻、一句没聊:云端 agent.create 记的占位首轮 / 根本没记首轮,都算', async () => {
    seedSession({ firstUtterance: RESIDENT_AGENT_FIRST_UTTERANCE, agentDisplayName: '个人助理' });
    await expect(isResidentNeverRun('s')).resolves.toBe(true);
  });

  it('没记首轮的也算', async () => {
    seedSession({ agentDisplayName: '个人助理' });
    await expect(isResidentNeverRun('s')).resolves.toBe(true);
  });

  it('阴控 —— 记着真首轮的(首轮没跑完):不算,照旧由「重来」照那句重来', async () => {
    seedSession({ firstUtterance: '帮我整理今天的日程' });
    await expect(isResidentNeverRun('s')).resolves.toBe(false);
  });

  it('阴控 —— 首轮在载荷里的:不算', async () => {
    seedSession({ firstUtterance: RESIDENT_AGENT_FIRST_UTTERANCE, initialQueue: [{ text: '帮我整理今天的日程' }] });
    await expect(isResidentNeverRun('s')).resolves.toBe(false);
  });

  it('阴控 —— 聊过(session_turns 有行):不算', async () => {
    seedSession({ firstUtterance: RESIDENT_AGENT_FIRST_UTTERANCE });
    seedTurn();
    await expect(isResidentNeverRun('s')).resolves.toBe(false);
  });
});

describe('clearProviderSessionMissing (#7223)', () => {
  it('起来的正是库里这一条:去掉 missing,别的原样,告诉渲染端', async () => {
    seedSession({ providerSessionState: 'missing', agentDisplayName: '个人助理' }, 'fresh');
    await expect(clearProviderSessionMissing('s', 'fresh')).resolves.toBe(true);
    expect(config()).not.toHaveProperty('providerSessionState');
    expect(config().agentDisplayName).toBe('个人助理');
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    // 网页宿主那条传输走 JSON:「去掉了」必须过得去(undefined 会连键一起丢)。
    const [, payload] = mocks.emit.mock.calls[0] as [unknown, { changes: Record<string, unknown> }];
    expect(JSON.parse(JSON.stringify(payload.changes))).toEqual({ providerSessionState: null });
  });

  it('库里的 id 已经不是刚起来的那个:不动', async () => {
    seedSession({ providerSessionState: 'missing' }, 'newer');
    await expect(clearProviderSessionMissing('s', 'fresh')).resolves.toBe(false);
    expect(config()).toMatchObject({ providerSessionState: 'missing' });
  });

  it('本来就没有 missing:不写、不播', async () => {
    seedSession({}, 'fresh');
    await expect(clearProviderSessionMissing('s', 'fresh')).resolves.toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
