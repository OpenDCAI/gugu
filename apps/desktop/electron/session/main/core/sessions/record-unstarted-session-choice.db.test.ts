import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, emit: vi.fn() }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: mocks.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { recordUnstartedSessionChoice } = await import('./record-unstarted-session-choice');
const { recordSessionPlatformModel, sessionPlatformModel } = await import('./platform-model-selection');

/**
 * #7092 免费号建了一条用会员模型的任务,首启签票被拒 ⇒ 这条会话从没起来过。换一个模型,只落记录、不停不起,
 * 由调用方按正常首启再起。落记录的规则与重开那条路相同:平台模型只进平台记录,自己的模型进 `config.model`。
 */
describe('recordUnstartedSessionChoice', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  const config = (id: string) => JSON.parse(
    (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string }).config,
  );

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockClear();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('pty-1', 'project-1', 'Task', 'codex', 'pty',
                '{"version":"1","type":"pty","effort":"high","initialPrompt":"hi","permissionMode":"edit"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('acp-1', 'project-1', 'Task', 'codex', 'acp',
                '{"version":"1","type":"acp","model":"gpt-own","permissionMode":"full-access"}');
    `);
    await recordSessionPlatformModel('pty-1', { modelId: 'glm-5.3' });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('switches a terminal task from a member model to a free one without touching the first prompt', async () => {
    await recordUnstartedSessionChoice({
      sessionId: 'pty-1', runtime: 'pty', reason: 'model-switch',
      model: 'glm-5.3-flash', modelSource: 'platform', effort: null,
    });

    await expect(sessionPlatformModel('pty-1')).resolves.toEqual({ modelId: 'glm-5.3-flash' });
    expect(config('pty-1')).toEqual({ version: '1', type: 'pty', initialPrompt: 'hi', permissionMode: 'edit' });
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'pty-1', projectId: 'project-1', changes: { model: null, effort: null },
    });
  });

  it('switches a chat task to the user\'s own model and tells the renderer which one', async () => {
    await recordUnstartedSessionChoice({
      sessionId: 'acp-1', runtime: 'acp', reason: 'model-switch', model: 'gpt-other', modelSource: 'own',
    });

    await expect(sessionPlatformModel('acp-1')).resolves.toBeNull();
    expect(config('acp-1')).toEqual({ version: '1', type: 'acp', model: 'gpt-other', permissionMode: 'full-access' });
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'acp-1', projectId: 'project-1', changes: { model: 'gpt-other' },
    });
  });

  it('refuses what the leg cannot take, and a call that records nothing', async () => {
    await expect(recordUnstartedSessionChoice({
      sessionId: 'acp-1', runtime: 'acp', reason: 'model-switch', effort: 'low',
    })).rejects.toThrow(/effort/);
    await expect(recordUnstartedSessionChoice({
      sessionId: 'pty-1', runtime: 'pty', reason: 'model-switch', model: 'glm-5.3-flash',
    })).rejects.toThrow(/modelSource/);
    await expect(recordUnstartedSessionChoice({
      sessionId: 'pty-1', runtime: 'pty', reason: 'manual',
    })).rejects.toThrow(/nothing to record/);
    expect(config('pty-1').effort).toBe('high');
    await expect(sessionPlatformModel('pty-1')).resolves.toEqual({ modelId: 'glm-5.3' });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
