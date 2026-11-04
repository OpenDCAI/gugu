import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { recordLiveModelSwitch } = await import('./live-model-switch');
const { sessionPlatformModel } = await import('./platform-model-selection');

/**
 * #6182 热切落地之后记录跟上 —— 与重开那条路落记录的规则相同:
 * 平台模型只进平台记录(`config.model` 删键),自己的模型进 `config.model`、平台记录记 null。
 * 同住 `config` 的其它事实(permissionMode 等)一个都不许丢。
 */
describe('recordLiveModelSwitch', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const config = () => JSON.parse(
    (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get('conv-1') as { config: string }).config,
  );

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('conv-1', 'project-1', 'copilot', 'acp',
                '{"version":"1","type":"acp","model":"own-model","permissionMode":"full-access"}');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('records a platform model as the platform decision and drops the native model key', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'glm-5.3-flash', source: 'platform' });

    await expect(sessionPlatformModel('conv-1')).resolves.toEqual({ modelId: 'glm-5.3-flash' });
    expect(config()).toEqual({ version: '1', type: 'acp', permissionMode: 'full-access' });
  });

  it('records an own model on the conversation config and marks the platform decision as none', async () => {
    await recordLiveModelSwitch({ sessionId: 'conv-1', modelId: 'provider-model', source: 'own' });

    await expect(sessionPlatformModel('conv-1')).resolves.toBeNull();
    expect(config()).toEqual({ version: '1', type: 'acp', model: 'provider-model', permissionMode: 'full-access' });
  });

  it('fails loudly for a conversation that has no record', async () => {
    await expect(
      recordLiveModelSwitch({ sessionId: 'missing', modelId: 'glm-5.3-flash', source: 'platform' }),
    ).rejects.toThrow(/no config/);
    await expect(sessionPlatformModel('missing')).resolves.toBeUndefined();
  });
});
