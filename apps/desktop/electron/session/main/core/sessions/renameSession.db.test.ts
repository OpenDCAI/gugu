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

import { adoptLegacyTaskNames, applyGeneratedTitle, applyHarnessTitle, renameSession, sessionTitleIsFallback } from './renameSession';
import { loadTaskNames, setTaskNameOwner, setTaskNamer, taskName } from './task-name';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent, listAgents, updateAgent, writeAgentName } from '@gugu/core/local/state/agents';

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

  it('renaming a bound session renames its identity on the host; binding emptied the pending-bind record', async () => {
    const env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'rename-bound-')) };
    await loadTaskNames(env);
    try {
      await createAgent({ name: 'Codex 7', agent_type: 'codex', path: '/w', prompt: '', gugu_user_id: 'agent-7' }, env);
      await updateAgent({ guguUserId: 'agent-7' }, { cache: { emdash_session_id: 'named', sessionpage_owner_user_id: 'owner' } }, env);
      await setTaskNameOwner('owner', env);
      await renameSession('named', 'Parser');
      expect(renameBound).toHaveBeenCalledWith('named', 'agent-7', 'Parser', 'manual');
      expect(nameOf('named')).toBeUndefined();
    } finally {
      await rm(env.GUGU_HOME, { recursive: true, force: true });
      await setTaskNameOwner(null, env); // an empty roster: no binding leaks into the next test
    }
  });

  it('one name at a time: binding empties the pending-bind record, signed out the identity still names the task, unbinding writes its last name back', async () => {
    const env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'bind-unbind-')) };
    await loadTaskNames(env);
    const rowName = () => taskName(fixture.sqlite.prepare('SELECT id, config FROM sessions WHERE id = ?').all('named').map((row) => {
      const { id, config } = row as { id: string; config: string };
      return { id, config: JSON.parse(config) };
    })[0]!);
    try {
      await setTaskNameOwner('owner', env);
      expect(nameOf('named')).toBe('Reviewer');
      await createAgent({ name: 'Reviewer', agent_type: 'codex', path: '/w', prompt: '', gugu_user_id: 'agent-7' }, env);
      await updateAgent({ guguUserId: 'agent-7' }, { cache: { emdash_session_id: 'named', sessionpage_owner_user_id: 'owner' } }, env);
      expect(nameOf('named')).toBeUndefined();
      await writeAgentName('agent-7', 'Release captain', 'cloud', env);

      // Signed out, or another account signed in: the task keeps its identity's name.
      await setTaskNameOwner(null, env);
      expect(rowName()).toBe('Release captain');
      await setTaskNameOwner('someone-else', env);
      expect(rowName()).toBe('Release captain');

      // Archiving releases the identity: its last name becomes the record a restored identity is named by.
      await updateAgent({ guguUserId: 'agent-7' }, { status: 'archived' }, env);
      expect(nameOf('named')).toBe('Release captain');
      expect(rowName()).toBe('Release captain');
    } finally {
      await rm(env.GUGU_HOME, { recursive: true, force: true });
      await setTaskNameOwner(null, env); // an empty roster: no binding leaks into the next test
    }
  });

  it('after the upgrade, a default-named identity takes its task\'s old title once; a chosen name, an unbound task and a non-title stay', async () => {
    const env = { GUGU_HOME: await mkdtemp(join(tmpdir(), 'legacy-names-')) };
    await loadTaskNames(env);
    const long = `${'长'.repeat(60)} ${'x'.repeat(60)}`;
    // The legacy `title` column is what 0043 left: the name each task showed before the upgrade.
    fixture.sqlite.exec(`
      INSERT INTO sessions (id, project_id, provider, runtime, title, config) VALUES
        ('renamed', 'project-1', 'claude', 'acp', '修登录页', '{"version":"1","type":"acp","agentDisplayName":"修登录页"}'),
        ('chosen', 'project-1', 'claude', 'acp', 'Old title', '{"version":"1","type":"acp","agentDisplayName":"Old title"}'),
        ('long', 'project-1', 'codex', 'pty', '${long}', '{"version":"1","type":"pty","agentDisplayName":"${long}"}'),
        ('unbound', 'project-1', 'claude', 'acp', 'Never bound', '{"version":"1","type":"acp","agentDisplayName":"Never bound"}'),
        ('blank', 'project-1', 'claude', 'acp', 'claude', '{"version":"1","type":"acp","agentDisplayName":"claude"}'),
        ('serial', 'project-1', 'claude', 'acp', 'Claude 4', '{"version":"1","type":"acp","agentDisplayName":"Claude 4"}');
    `);
    const bind = async (sessionId: string, agentUserId: string, name: string, agentType = 'claude') => {
      await createAgent({ name, agent_type: agentType, path: '/w', prompt: '', gugu_user_id: agentUserId }, env);
      await updateAgent({ guguUserId: agentUserId }, { cache: { emdash_session_id: sessionId, sessionpage_owner_user_id: 'owner' } }, env);
    };
    // The host's rename writes the roster (pending, then published); the projection follows it.
    const renameOnRoster = vi.fn(async (_sessionId: string, agentUserId: string, name: string) => {
      await writeAgentName(agentUserId, name, 'local', env);
    });
    setTaskNamer({ defaultName: async () => 'unused', renameBound: renameOnRoster });
    try {
      await bind('renamed', 'agent-a', 'Claude 127');
      await bind('chosen', 'agent-b', 'Release captain');
      await bind('long', 'agent-c', 'Codex 12', 'codex');
      await bind('blank', 'agent-d', 'Claude 3');
      await bind('serial', 'agent-e', 'Claude 9');
      await setTaskNameOwner('owner', env);

      expect(await adoptLegacyTaskNames()).toBe(2);
      expect(renameOnRoster.mock.calls).toEqual([
        ['renamed', 'agent-a', '修登录页', 'auto'],
        ['long', 'agent-c', long.slice(0, 100), 'auto'],
      ]);
      const names = Object.fromEntries((await listAgents(env)).map((agent) => [agent.gugu_user_id, agent.name]));
      expect(names).toMatchObject({
        'agent-a': '修登录页', 'agent-b': 'Release captain', 'agent-c': long.slice(0, 100), 'agent-d': 'Claude 3', 'agent-e': 'Claude 9',
      });
      expect(nameOf('unbound')).toBe('Never bound');

      // Once: the renamed identities are no longer defaults, so the next start changes nothing.
      renameOnRoster.mockClear();
      expect(await adoptLegacyTaskNames()).toBe(0);
      expect(renameOnRoster).not.toHaveBeenCalled();
    } finally {
      await rm(env.GUGU_HOME, { recursive: true, force: true });
      await setTaskNameOwner(null, env); // an empty roster: no binding leaks into the next test
    }
  });
});
