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

const renameBound = vi.fn(async (_sessionId: string, _agentUserId: string, _name: string) => {});

import { applyGeneratedTitle, applyHarnessTitle, renameSession, sessionTitleIsFallback } from './renameSession';
import { setTaskNameOwner, setTaskNamer } from './task-name';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, updateAgent } from '@gugu/core/local/state/agents';

// One name per task (task-name.ts). A person's rename always applies; an automatic name (the harness's
// own title or gugu's generated one) only replaces the engine default, so the first one wins once.
describe('task name renames', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  const nameOf = (id: string) => {
    const row = fixture.sqlite.prepare('SELECT config FROM sessions WHERE id = ?').get(id) as { config: string };
    return JSON.parse(row.config).agentDisplayName as string;
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    mocks.renamed.mockReset();
    renameBound.mockClear();
    setTaskNamer({ defaultName: async () => 'unused', renameBound });
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('default', 'project-1', 'claude', 'acp',
                '{"version":"1","type":"acp","agentDisplayName":"Claude 2","firstUtterance":"In one sentence, without reading any files, what is gugu?"}');
      INSERT INTO sessions (id, project_id, provider, runtime, config)
        VALUES ('named', 'project-1', 'codex', 'pty',
                '{"version":"1","type":"pty","agentDisplayName":"Reviewer"}');
    `);
  });

  afterEach(() => {
    setTaskNamer(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('an automatic name replaces the engine default once and is announced to search and the renderer', async () => {
    expect(sessionTitleIsFallback('default').fallback).toBe(true);
    expect(await applyHarnessTitle('default', 'Explain gugu briefly')).toBe(true);
    expect(nameOf('default')).toBe('Explain gugu briefly');
    expect(mocks.renamed).toHaveBeenCalledWith('session:renamed', 'default', 'project-1', 'Explain gugu briefly');
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'default', projectId: 'project-1', changes: { title: 'Explain gugu briefly' },
    });
    // The first automatic name wins: neither the harness nor gugu renames it again.
    expect(sessionTitleIsFallback('default').fallback).toBe(false);
    expect(await applyHarnessTitle('default', 'Something else')).toBe(false);
    expect(await applyGeneratedTitle('default', 'Generated')).toBe(false);
    expect(nameOf('default')).toBe('Explain gugu briefly');
  });

  it('an automatic name never overrides a chosen name; a person can always rename', async () => {
    expect(await applyHarnessTitle('named', 'Harness idea')).toBe(false);
    expect(await applyGeneratedTitle('named', 'Generated idea')).toBe(false);
    await renameSession('named', '  Lead   reviewer ');
    expect(nameOf('named')).toBe('Lead reviewer');
    await renameSession('default', 'Pinned');
    expect(await applyGeneratedTitle('default', 'Generated')).toBe(false);
    expect(nameOf('default')).toBe('Pinned');
  });

  it('a "name" that only echoes the first prompt, or repeats the current one, writes nothing', async () => {
    expect(await applyHarnessTitle('default', 'In one sentence, without reading any files, what is gugu?')).toBe(false);
    expect(await applyHarnessTitle('default', '<gugu_delivery from="x">hi')).toBe(false);
    expect(await applyHarnessTitle('default', 'Claude 2')).toBe(false);
    expect(nameOf('default')).toBe('Claude 2');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('a blank automatic title is no name; a blank or unknown rename fails loudly', async () => {
    expect(await applyHarnessTitle('default', '   ')).toBe(false);
    await expect(renameSession('default', '  ')).rejects.toThrow(/empty name/);
    await expect(renameSession('missing', 'X')).rejects.toThrow(/not found/);
  });

  it('renaming a bound session renames its identity on the host and leaves the pending-bind record alone', async () => {
    const env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'rename-bound-')) };
    try {
      await createAgent({ name: 'Codex 7', agent_type: 'codex', path: '/w', prompt: '', gugu_user_id: 'agent-7' }, env);
      await updateAgent({ guguUserId: 'agent-7' }, { cache: { emdash_session_id: 'named', sessionpage_owner_user_id: 'owner' } }, env);
      await setTaskNameOwner('owner', env);
      await renameSession('named', 'Parser');
      expect(renameBound).toHaveBeenCalledWith('named', 'agent-7', 'Parser', 'manual');
      expect(nameOf('named')).toBe('Reviewer');
    } finally {
      await setTaskNameOwner(null, env);
      await rm(env.GUGU_HOME, { recursive: true, force: true });
    }
  });
});
