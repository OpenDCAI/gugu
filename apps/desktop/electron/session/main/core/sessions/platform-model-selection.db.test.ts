import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import * as schema from '@main/db/schema';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  composerPlatformModel,
  sessionPlatformModel,
  forgetSessionPlatformModel,
  recordSessionPlatformModel,
} = await import('./platform-model-selection');

const SESSION = 'conv-2503';

describe('#2503 composer 的选择记在会话上', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let reopened: Database.Database | null = null;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    reopened?.close();
    reopened = null;
    fixture.close();
    mocks.db = undefined;
  });

  it('tells "picked the harness" apart from "never picked at all"', async () => {
    // 这是整条回退逻辑的支点:没有记录 = 本决定出现之前建的存量会话 → 回退 agent 级配置;
    // 记着 null = 用户明确选了 harness 自家模型 → 什么都不注入。两者读回来必须不同。
    await expect(sessionPlatformModel(SESSION)).resolves.toBeUndefined();

    await recordSessionPlatformModel(SESSION, null);
    await expect(sessionPlatformModel(SESSION)).resolves.toBeNull();
  });

  it('survives a restart, because the decision outlives the process that took it', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    // 关掉再从同一个库文件重新打开 = 重启后重新 spawn 时读到的东西,而不是进程里的残留状态。
    const path = fixture.sqlite.name;
    fixture.sqlite.close();
    reopened = new Database(path);
    mocks.db = drizzle(reopened, { schema }) as unknown as AppDb;

    await expect(sessionPlatformModel(SESSION)).resolves.toEqual({ modelId: 'glm-5.2' });
  });

  it('keeps every conversation on its own decision', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    await recordSessionPlatformModel('conv-other', null);

    await expect(sessionPlatformModel(SESSION)).resolves.toEqual({ modelId: 'glm-5.2' });
    await expect(sessionPlatformModel('conv-other')).resolves.toBeNull();
  });

  it('forgets the record when the conversation is gone', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    await forgetSessionPlatformModel(SESSION);

    await expect(sessionPlatformModel(SESSION)).resolves.toBeUndefined();
  });

  it('reads the creation payload as three distinct answers, not two', () => {
    // ① 选了平台模型。
    expect(composerPlatformModel({ platformModel: { modelId: ' glm-5.2 ' } })).toEqual({ modelId: 'glm-5.2' });
    // ② 明确选了 harness —— composer 发的是显式 null。
    expect(composerPlatformModel({ platformModel: null })).toBeNull();
    // ③ 根本没有 composer(自动化任务、派生子会话、导入):**不是**「选了 BYOK」。记成 ② 会把这些
    //    会话永久钉死在 BYOK,而它们本该沿用 agent 级默认(改动前的行为)。
    expect(composerPlatformModel({})).toBeUndefined();
    expect(composerPlatformModel({ platformModel: undefined })).toBeUndefined();
    // 字段在但值坏了:客户端确实做了决定,只是坏了 —— 退化成「用 agent 的平台模型」是最不该有的解释。
    expect(composerPlatformModel({ platformModel: { modelId: '' } })).toBeNull();
  });
});
