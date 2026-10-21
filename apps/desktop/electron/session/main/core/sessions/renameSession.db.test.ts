import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
  renamed: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: mocks.emit },
}));

vi.mock('./session-events', () => ({
  sessionEvents: { _emit: mocks.renamed },
}));

import { applyGeneratedTitle, applyHarnessTitle, renameSession, sessionTitleIsFallback } from './renameSession';

// 优先级:显式命名(人/agent)> harness 自己拟的名 > 首轮兜底。
describe('conversation title precedence', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  const rowOf = (id: string) => {
    const row = fixture.sqlite
      .prepare('SELECT title, config FROM sessions WHERE id = ?')
      .get(id) as { title: string; config: string };
    return { title: row.title, titleSource: JSON.parse(row.config).titleSource as string | undefined };
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    mocks.renamed.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('fallback', 'project-1', 'In one sentence, without reading any fil…', 'claude', 'acp',
                '{"version":"1","type":"acp","firstUtterance":"In one sentence, without reading any files, what is gugu?"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('named', 'project-1', 'Reviewer', 'codex', 'pty',
                '{"version":"1","type":"pty","agentDisplayName":"Reviewer","titleSource":"manual"}');
      -- 这一格出现之前落库的老会话:没有 titleSource。
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('legacy-named', 'project-1', 'Migration reviewer', 'claude', 'pty',
                '{"version":"1","type":"pty","firstUtterance":"Review the migration in PR 12"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('legacy-spawned', 'project-1', 'Review the migration in PR 12', 'claude', 'pty',
                '{"version":"1","type":"pty","firstUtterance":"Review the migration in PR 12\\nthen report back"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('legacy-counter', 'project-1', 'Claude (2)', 'claude', 'acp',
                '{"version":"1","type":"acp"}');
      INSERT INTO sessions (id, project_id, title, provider, runtime, config)
        VALUES ('no-config', 'project-1', 'Old name', 'claude', 'pty', NULL);
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('a harness title replaces the first-utterance fallback and is published to the renderer', () => {
    expect(applyHarnessTitle('fallback', 'Understand what gugu is')).toBe(true);

    expect(rowOf('fallback')).toEqual({ title: 'Understand what gugu is', titleSource: 'harness' });
    // 其余 config 键原样留着:标题只动 titleSource 这一格。
    expect(
      JSON.parse(
        (fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get('fallback') as { config: string }).config
      ).firstUtterance
    ).toBe('In one sentence, without reading any files, what is gugu?');
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'fallback',
      projectId: 'project-1',
      changes: { title: 'Understand what gugu is' },
    });
    expect(mocks.renamed).toHaveBeenCalledWith(
      'session:renamed', 'fallback', 'project-1', 'Understand what gugu is'
    );
  });

  it('a later harness title follows the harness', () => {
    applyHarnessTitle('fallback', 'Understand what gugu is');
    expect(applyHarnessTitle('fallback', 'Explain gugu architecture')).toBe(true);
    expect(rowOf('fallback').title).toBe('Explain gugu architecture');
  });

  it('a harness title never overrides an explicit name', () => {
    expect(applyHarnessTitle('named', 'Review the migration')).toBe(false);
    expect(rowOf('named')).toEqual({ title: 'Reviewer', titleSource: 'manual' });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('a manual rename pins the title against later harness titles', async () => {
    applyHarnessTitle('fallback', 'Understand what gugu is');
    await renameSession('fallback', '  gugu notes  ');
    expect(rowOf('fallback')).toEqual({ title: 'gugu notes', titleSource: 'manual' });

    expect(applyHarnessTitle('fallback', 'Something else')).toBe(false);
    expect(rowOf('fallback').title).toBe('gugu notes');
  });

  it('repeating the same harness title is a no-op (reattach / session/load replay)', () => {
    applyHarnessTitle('fallback', 'Understand what gugu is');
    mocks.emit.mockReset();
    expect(applyHarnessTitle('fallback', 'Understand what gugu is')).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  // Claude 的 ACP 桥拟名失败时回退 `summary`(原样的首轮),Copilot 的默认名就是首条消息 —— 那是兜底档。
  it('a "title" that just echoes the first prompt is not a harness title', () => {
    const prompt = 'In one sentence, without reading any files, what is gugu?';
    expect(applyHarnessTitle('fallback', prompt)).toBe(false);
    expect(applyHarnessTitle('fallback', `${prompt.slice(0, 45)}…`)).toBe(false);
    expect(applyHarnessTitle('fallback', '<gugu_delivery route="session-direct" from="Claude 3"> In one')).toBe(false);
    expect(applyHarnessTitle('fallback', `${prompt} (session context follows)`)).toBe(false);
    expect(rowOf('fallback').titleSource).toBeUndefined();
    // 阳控:一个恰好是首轮开头几个词的短名照样收 —— 只拦「整句回声」。
    expect(applyHarnessTitle('fallback', 'In one sentence')).toBe(true);
  });

  // 人在咕咕里改的名是最高档:harness 之后怎么改(自己拟的、还是人在它的 TUI 里 `/rename` 的)都不盖它。
  it('nothing the harness reports overrides a name given in gugu', async () => {
    await renameSession('fallback', 'Bar');
    expect(applyHarnessTitle('fallback', 'Renamed in the TUI')).toBe(false);
    expect(rowOf('fallback')).toEqual({ title: 'Bar', titleSource: 'manual' });
  });

  it('legacy rows keep explicit names; only the fallback shapes gugu derives are replaceable', () => {
    expect(applyHarnessTitle('legacy-named', 'PR 12 migration review')).toBe(false);
    expect(rowOf('legacy-named').title).toBe('Migration reviewer');
    // session_spawn 没给 title 时是首轮第一行;没有首轮时是引擎计数 —— 都是兜底。
    expect(applyHarnessTitle('legacy-spawned', 'PR 12 migration review')).toBe(true);
    expect(applyHarnessTitle('legacy-counter', 'Casual greeting')).toBe(true);
  });

  it('a row without config treats its title as explicit and can still be renamed', async () => {
    expect(applyHarnessTitle('no-config', 'Something')).toBe(false);
    await renameSession('no-config', 'New name');
    expect(
      fixture.sqlite.prepare('SELECT title, config FROM sessions WHERE id = ?').get('no-config')
    ).toEqual({ title: 'New name', config: null });
  });

  // #7337 自动名有两个来源(咕咕起的、harness 起的):先到先得、只起一次;显式命名照样压过两者。
  it('a generated title replaces the fallback, and then the harness no longer overrides it', () => {
    expect(sessionTitleIsFallback('fallback')).toEqual({
      fallback: true,
      firstUtterance: 'In one sentence, without reading any files, what is gugu?',
    });
    expect(applyGeneratedTitle('fallback', 'gugu overview')).toBe(true);
    expect(rowOf('fallback')).toEqual({ title: 'gugu overview', titleSource: 'generated' });
    expect(sessionTitleIsFallback('fallback').fallback).toBe(false);

    expect(applyHarnessTitle('fallback', 'Understand what gugu is')).toBe(false);
    expect(rowOf('fallback').title).toBe('gugu overview');
  });

  it('gugu does not generate over a harness title, an explicit name, or a legacy explicit row', async () => {
    applyHarnessTitle('fallback', 'Understand what gugu is');
    expect(applyGeneratedTitle('fallback', 'gugu overview')).toBe(false);
    expect(rowOf('fallback')).toEqual({ title: 'Understand what gugu is', titleSource: 'harness' });

    expect(applyGeneratedTitle('named', 'Migration review')).toBe(false);
    expect(applyGeneratedTitle('legacy-named', 'Migration review')).toBe(false);
    expect(applyGeneratedTitle('no-config', 'Something')).toBe(false);
    expect(sessionTitleIsFallback('named').fallback).toBe(false);
    expect(sessionTitleIsFallback('missing')).toEqual({ fallback: false, firstUtterance: undefined });
  });

  it('a manual rename still pins the title over a generated one', async () => {
    applyGeneratedTitle('fallback', 'gugu overview');
    await renameSession('fallback', 'Bar');
    expect(rowOf('fallback')).toEqual({ title: 'Bar', titleSource: 'manual' });
    expect(applyGeneratedTitle('fallback', 'gugu overview')).toBe(false);
  });

  it('a generated "title" that just echoes the first prompt is not taken', () => {
    expect(applyGeneratedTitle('fallback', 'In one sentence, without reading any files, what is gugu?')).toBe(false);
    expect(rowOf('fallback').titleSource).toBeUndefined();
  });

  it('blank or missing targets write nothing', () => {
    expect(applyHarnessTitle('fallback', '   ')).toBe(false);
    expect(applyHarnessTitle('missing', 'Title')).toBe(false);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
