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
/** The platform catalog the model menu reads (a network call each): what it was asked, and whether it answers. */
const catalog = vi.hoisted(() => ({ queries: [] as unknown[], down: false, names: { 'glm-5.2': 'GLM 5.2', 'glm-5.3-flash': 'GLM 5.3 Flash' } as Record<string, string> }));
vi.mock('@main/core/agents/platform-model-catalog-hook', () => ({
  getPlatformModelCatalogResolver: () => async (query: unknown) => {
    catalog.queries.push(query);
    if (catalog.down) throw new Error('gugu-models:service-unavailable');
    return { models: Object.entries(catalog.names).map(([id, displayName]) => ({ id, displayName })), catalogError: null };
  },
}));

const {
  composerPlatformModel,
  sessionModelLabel,
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

describe('a Gugu model\'s menu name, filled in on first read and kept with the decision', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const label = async () => sessionModelLabel(SESSION, await sessionPlatformModel(SESSION), 'claude', 'acp');

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    catalog.queries.length = 0;
    catalog.down = false;
  });
  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('asks the catalog once for a session and model, however many calls read it', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    expect([await label(), await label(), await label()]).toEqual(['GLM 5.2', 'GLM 5.2', 'GLM 5.2']);
    expect(catalog.queries).toEqual([{ providerId: 'claude', surface: 'acp' }]);
    // Kept beside the id, the id unchanged.
    await expect(sessionPlatformModel(SESSION)).resolves.toEqual({ modelId: 'glm-5.2', label: 'GLM 5.2' });
  });

  it('a switch writes a decision without the old name: the next read asks once more and names the new model', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    await label();
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.3-flash' });
    expect([await label(), await label()]).toEqual(['GLM 5.3 Flash', 'GLM 5.3 Flash']);
    expect(catalog.queries).toHaveLength(2);
  });

  it('a catalog that cannot answer gives null and keeps nothing, so the next read asks again; an engine\'s own model is never asked', async () => {
    await recordSessionPlatformModel(SESSION, { modelId: 'glm-5.2' });
    catalog.down = true;
    await expect(label()).resolves.toBeNull();
    await expect(sessionPlatformModel(SESSION)).resolves.toEqual({ modelId: 'glm-5.2' });
    catalog.down = false;
    await expect(label()).resolves.toBe('GLM 5.2');
    expect(catalog.queries).toHaveLength(2);
    await recordSessionPlatformModel(SESSION, null);
    await expect(label()).resolves.toBeNull();
    expect(catalog.queries).toHaveLength(2);
  });
});
