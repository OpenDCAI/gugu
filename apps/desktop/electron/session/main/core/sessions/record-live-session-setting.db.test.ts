import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

/**
 * 活会话上改过、provider 已确认的设置,必须**落进会话记录**,重开时才读得回来。
 *
 * 修之前:composer 改权限档 / 模型只打到活运行时,记录里仍是建会话时那一档;两条启动路
 * (渲染层 `_startInput`、主进程 `acpStartInputFor`)都从 `mapSessionRowToSession`
 * 出来的 Conversation 读 `permissionMode` / `model`,运行时在 `session/load` 上重新下发 ⇒
 * 重开即回退。权限那一维回退的方向是**更松**(完全访问 → 用户收紧到只读 → 重开又是完全访问)。
 *
 * 判据形状是**往返**:中途改 → 写记录 → 按重开那条路读回来,读到的是新值。
 */

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { recordLiveSessionSetting } = await import('./record-live-session-setting');
const { mapSessionRowToSession } = await import('./utils');
const { sessions } = await import('@main/db/schema');
const { eq } = await import('drizzle-orm');

const CONV = 'conv-1';

describe('活会话设置落库:改完 → 记录 → 重开读到新值', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('${CONV}', 'project-1', 'Task', 'claude', 'acp',
                '{"version":"1","type":"acp","permissionMode":"full-access","model":"opus","effort":"high","firstUtterance":"hi","mcpSessionServers":["gugu"]}');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  /** 重开那条路读到的 Conversation —— 两条启动路的 permissionMode / model / effort 都取自它。 */
  async function reopened() {
    const [row] = await fixture.db.select().from(sessions).where(eq(sessions.id, CONV));
    return mapSessionRowToSession(row!);
  }

  it('权限:完全访问中途收紧到只读(claude 的 `default`),重开读到只读而不是完全访问', async () => {
    await recordLiveSessionSetting(CONV, { dimension: 'permission', modeId: 'default' });

    const session = await reopened();
    expect(session.permissionMode).toBe('read-only');
    // 读-改-写:同住一份 JSON 的其它事实不许被抹掉。
    expect(session.model).toBe('opus');
    expect(session.effort).toBe('high');
    expect(session.mcpSessionServers).toEqual(['gugu']);
    // 渲染层手里那份也得跟上(它自己的启动路读的是它)。
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: CONV,
      projectId: 'project-1',
      changes: { permissionMode: 'read-only' },
    });
  });

  it('权限:别名档(`dontAsk`)归到它声明的那一档', async () => {
    await recordLiveSessionSetting(CONV, { dimension: 'permission', modeId: 'dontAsk' });
    expect((await reopened()).permissionMode).toBe('read-only');
  });

  it('权限:咕咕故意不映射的档(claude `auto`)不写 —— 硬归一档重开时会切到另一个 id', async () => {
    await recordLiveSessionSetting(CONV, { dimension: 'permission', modeId: 'auto' });
    const session = await reopened();
    expect(session.permissionMode).toBe('full-access');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('推理档:原样写回', async () => {
    await recordLiveSessionSetting(CONV, { dimension: 'effort', value: 'low' });
    expect((await reopened()).effort).toBe('low');
  });

  it('连着改两维(不等前一次写完):两维都留在记录里,❌ 后写的那次盖掉前一次', async () => {
    await Promise.all([
      recordLiveSessionSetting(CONV, { dimension: 'permission', modeId: 'default' }),
      recordLiveSessionSetting(CONV, { dimension: 'effort', value: 'low' }),
    ]);
    const session = await reopened();
    expect(session.permissionMode).toBe('read-only');
    expect(session.effort).toBe('low');
  });

  it('会话不存在 ⇒ 响亮失败', async () => {
    await expect(
      recordLiveSessionSetting('missing', { dimension: 'effort', value: 'low' }),
    ).rejects.toThrow(/Session not found/);
  });
});
