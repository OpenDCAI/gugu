import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined, home: '', mounted: false, groups: vi.fn(), task: vi.fn(), emit: vi.fn() }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('No fixture'); return state.db; } }));
vi.mock('@gugu/core/local/state/paths', () => ({ resolveGuguHome: () => state.home }));
vi.mock('@main/core/sessions/session-workspace-manager', () => ({ sessionWorkspaceManager: { getSession: () => state.mounted ? {} : undefined } }));
vi.mock('../project-group-host', () => ({ projectGroupHost: () => ({ listBindings: state.groups }) }));
vi.mock('./resolve-agent-session-project', () => ({ resolveAgentSessionProject: state.task }));
vi.mock('../project-events', () => ({ projectEvents: { _emit: state.emit } }));

import { getAssistantProjectCleanupReport, migrateAssistantProject, noteAssistantProjectCandidate, runPendingAssistantProjectCleanup, setAssistantProjectCleanupOwner } from './assistant-project-cleanup';
import { recordProjectRegistration } from './project-registration-origin';
import { readProjects } from './getProjects';
import { resolveAssistantSessionWorkspace } from './task-directory-workspace';
import { sessionHere } from '../../extensions/extension-show-session';
import { viewStateService } from '../../view-state/view-state-service';

const TASKS = '00000000-0000-4000-8000-000000000001';
describe('assistant project registration removal', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let path: string;
  const candidate = () => ({ projectId: 'old', path, sessionId: 'assistant', assistantId: 'agent-own', deviceId: 'device-own', ownerId: 'owner-own' });
  const origin = (source: 'automatic' | 'person') => recordProjectRegistration({ projectId: 'old', path, createdAt: '2026-01-01 00:00:00', source });
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db;
    setAssistantProjectCleanupOwner(async () => 'owner-own', async () => 'device-own');
    state.home = mkdtempSync(join(tmpdir(), 'gugu-assistant-project-'));
    path = join(state.home, 'assistant');
    // An existing, ordinary directory with real content, not a fake Git repository.
    const { mkdirSync } = await import('node:fs'); mkdirSync(path); writeFileSync(join(path, 'memory.md'), 'keep this memory\n');
    state.mounted = false; state.groups.mockReset().mockResolvedValue({ success: true, data: [] }); state.emit.mockClear();
    fixture.sqlite.prepare('INSERT INTO projects(id,name,path,kind,gitless,created_at) VALUES(?,?,?,?,?,?)').run('old', 'assistant', path, 'project', 1, '2026-01-01 00:00:00');
    fixture.sqlite.prepare('INSERT INTO projects(id,name,path,kind,gitless) VALUES(?,?,?,?,?)').run(TASKS, 'tasks', join(state.home, 'task-home'), 'workspace', 1);
    fixture.sqlite.prepare('INSERT INTO workspaces(id,kind,type,location,path,key) VALUES(?,?,?,?,?,?)').run('cwd', 'project-root', 'local', 'local', path, 'old-key');
    fixture.sqlite.exec("UPDATE projects SET repository_workspace_id='cwd' WHERE id='old'");
    fixture.sqlite.exec("INSERT INTO sessions(id,project_id,workspace_id,runtime,provider_session_id) VALUES('assistant','old','cwd','acp','native-history'); INSERT INTO sessions(id,project_id,workspace_id,runtime,parent_session_id) VALUES('child','old','cwd','acp','assistant')");
    fixture.sqlite.exec("INSERT INTO terminals(id,project_id,session_id,name) VALUES('terminal','old','child','shell'); INSERT INTO editor_buffers(id,project_id,workspace_id,file_path,content,updated_at) VALUES('old:cwd:note.md','old','cwd','note.md','unsaved',1)");
    fixture.sqlite.exec("INSERT INTO kv(key,value,updated_at) VALUES('native-conversation-inbox:assistant','{\"projectId\":\"old\",\"chatId\":\"dm\"}',1)");
    state.task.mockReset().mockResolvedValue({ id: TASKS, type: 'local', path: join(state.home, 'task-home') });
  });
  afterEach(() => { fixture.close(); rmSync(state.home, { recursive: true, force: true }); state.db = undefined; });

  it('a new assistant directory adds a workspace, never a directory project; keeps the real cwd', async () => {
    const fresh = join(state.home, 'new-assistant'); const { mkdirSync } = await import('node:fs'); mkdirSync(fresh);
    const before = fixture.sqlite.prepare('SELECT count(*) AS n FROM projects').get();
    const first = await resolveAssistantSessionWorkspace(fresh), again = await resolveAssistantSessionWorkspace(fresh);
    expect(first.project.id).toBe(TASKS); expect(first.path).toBe(fresh); expect(again.workspaceId).toBe(first.workspaceId);
    expect(fixture.sqlite.prepare('SELECT count(*) AS n FROM projects').get()).toEqual(before);
    expect(fixture.sqlite.prepare('SELECT path,kind,project_id FROM workspaces WHERE id=?').get(first.workspaceId)).toEqual({ path: fresh, kind: 'path', project_id: null });
    expect(state.task).toHaveBeenCalledWith('');
  });

  it('removes a proven automatic registration only after backing it up; keeps history, parents, files, buffers and workspace IDs', async () => {
    await viewStateService.save('navigation', { currentViewId: 'session', viewParams: { session: { projectId: 'old', sessionId: 'assistant' } } });
    origin('automatic');
    const result = await migrateAssistantProject(candidate());
    expect(result.status).toBe('removed'); expect(result.taskProjectId).toBe(TASKS);
    expect(readProjects().map(row => row.id)).toEqual([TASKS]);
    // Notifications and OS session links resolve this canonical row, not a stale project hint.
    expect(await sessionHere('assistant')).toBe(TASKS);
    expect(await viewStateService.get('navigation')).toEqual({ currentViewId: 'session', viewParams: { session: { projectId: TASKS, sessionId: 'assistant' } } });
    expect(fixture.sqlite.prepare('SELECT id,project_id,workspace_id,provider_session_id,parent_session_id,archived_at FROM sessions ORDER BY id').all()).toEqual([
      { id: 'assistant', project_id: TASKS, workspace_id: 'cwd', provider_session_id: 'native-history', parent_session_id: null, archived_at: null },
      { id: 'child', project_id: TASKS, workspace_id: 'cwd', provider_session_id: null, parent_session_id: 'assistant', archived_at: null },
    ]);
    expect(fixture.sqlite.prepare('SELECT project_id FROM terminals').get()).toEqual({ project_id: TASKS });
    expect(fixture.sqlite.prepare('SELECT id,content,project_id FROM editor_buffers').get()).toEqual({ id: `${TASKS}:cwd:note.md`, content: 'unsaved', project_id: TASKS });
    expect(JSON.parse(String(fixture.sqlite.prepare('SELECT value FROM kv WHERE key=?').pluck().get('native-conversation-inbox:assistant')))).toEqual({ projectId: TASKS, chatId: 'dm' });
    expect(readFileSync(join(path, 'memory.md'), 'utf8')).toBe('keep this memory\n'); expect(readdirSync(path)).toEqual(['memory.md']);
    const backup = JSON.parse(readFileSync(result.backup!, 'utf8'));
    expect(backup.before.project.id).toBe('old'); expect(backup.before.tasks).toHaveLength(2); expect(backup.before.buffers[0].content).toBe('unsaved');
    expect(backup.before.viewState).toHaveLength(1);
    expect(JSON.parse(backup.before.viewState[0].value).viewParams.session.projectId).toBe('old');
    expect(statSync(result.backup!).mode & 0o777).toBe(0o600);
    expect(await getAssistantProjectCleanupReport()).toMatchObject({ total: 0, removed: [{ projectId: 'old', deviceId: 'device-own' }] });
  });

  it.each(['project', 'workspace'])('retains an unknown legacy %s, even when it has exactly the assistant path', async kind => {
    fixture.sqlite.prepare('UPDATE projects SET kind=? WHERE id=?').run(kind, 'old');
    const result = await migrateAssistantProject(candidate());
    expect(result).toMatchObject({ status: 'retained', reason: 'legacy-origin-unknown' });
    expect(fixture.sqlite.prepare('SELECT project_id FROM sessions WHERE id=?').get('assistant')).toEqual({ project_id: 'old' });
    expect(await getAssistantProjectCleanupReport()).toMatchObject({ total: 1, retained: [{ projectId: 'old', path, deviceId: 'device-own', reason: 'legacy-origin-unknown' }] });
  });

  it('never touches a manually created or subsequently claimed project', async () => {
    origin('automatic'); origin('person');
    expect(await migrateAssistantProject(candidate())).toMatchObject({ status: 'retained', reason: 'person-created-or-claimed' });
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
  });

  it('retains a formerly automatic registration if unrelated tasks also use it', async () => {
    origin('automatic');
    fixture.sqlite.exec("INSERT INTO sessions(id,project_id,workspace_id,runtime) VALUES('user-task','old','cwd','acp')");
    expect(await migrateAssistantProject(candidate())).toMatchObject({ status: 'retained', reason: 'other-task-uses-project' });
  });

  it('repeating a completed removal is idempotent and retains the original backup', async () => {
    origin('automatic'); const first = await migrateAssistantProject(candidate());
    expect(await migrateAssistantProject(candidate())).toEqual(first);
  });

  it('requires confirmation of both the exact ID and exact path for an unknown row', async () => {
    expect(await migrateAssistantProject({ ...candidate(), ownerConfirmed: { projectId: 'old', path: '/wrong' } })).toMatchObject({ status: 'retained' });
    expect(await migrateAssistantProject({ ...candidate(), ownerConfirmed: { projectId: 'old', path } })).toMatchObject({ status: 'removed', reason: 'owner-confirmed' });
  });

  it('backs up and defers a mounted task instead of interrupting it; the cold-start pass finishes the saved request', async () => {
    origin('automatic'); state.mounted = true;
    const result = await migrateAssistantProject(candidate());
    expect(result).toMatchObject({ status: 'retained', reason: 'pending-restart' }); expect(result.backup).toBeTruthy();
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
    state.mounted = false; await runPendingAssistantProjectCleanup(true);
    expect(readProjects().map(row => row.id)).toEqual([TASKS]);
  });

  it('lists unbound legacy app directories with count, machine and path without removing them', async () => {
    const report = await getAssistantProjectCleanupReport();
    expect(report).toMatchObject({ deviceId: 'device-own', total: 1, retained: [{ projectId: 'old', path, deviceId: 'device-own', reason: 'unbound-origin-unproven' }] });
    await runPendingAssistantProjectCleanup(true);
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
  });

  it('discovers restored canonical assistant projects at startup before someone opens the assistant', async () => {
    origin('automatic');
    setAssistantProjectCleanupOwner(async () => 'owner-own', async () => 'device-own', async () => [{ assistantId: 'agent-own', sessionId: 'assistant' }]);
    await runPendingAssistantProjectCleanup(true);
    expect(readProjects().map(row => row.id)).toEqual([TASKS]);
    expect((await getAssistantProjectCleanupReport()).removed).toHaveLength(1);
  });

  it('does not block startup or guess ownership while role discovery is unavailable; retries after reconnect', async () => {
    origin('automatic');
    const discover = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ assistantId: 'agent-own', sessionId: 'assistant' }]);
    setAssistantProjectCleanupOwner(async () => 'owner-own', async () => 'device-own', discover);
    await expect(runPendingAssistantProjectCleanup(true)).resolves.toBeUndefined();
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
    await runPendingAssistantProjectCleanup(true);
    expect(readProjects().map(row => row.id)).toEqual([TASKS]);
  });

  it('reports a discovered unknown legacy directory even outside app-owned directories, retaining all files', async () => {
    const outer = mkdtempSync(join(tmpdir(), 'legacy-assistant-outside-'));
    fixture.sqlite.prepare('UPDATE projects SET path=? WHERE id=?').run(outer, 'old');
    fixture.sqlite.prepare('UPDATE workspaces SET path=? WHERE id=?').run(outer, 'cwd');
    setAssistantProjectCleanupOwner(async () => 'owner-own', async () => 'device-own', async () => [{ assistantId: 'agent-own', sessionId: 'assistant' }]);
    try {
      await runPendingAssistantProjectCleanup(true);
      expect(await getAssistantProjectCleanupReport()).toMatchObject({ total: 1, retained: [{ projectId: 'old', path: outer, deviceId: 'device-own', reason: 'legacy-origin-unknown' }] });
      expect(readProjects().some(row => row.id === 'old')).toBe(true);
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it('cannot inspect or change another account’s pending registration', async () => {
    origin('automatic'); noteAssistantProjectCandidate(candidate());
    setAssistantProjectCleanupOwner(async () => 'another-owner', async () => 'device-own');
    expect(await getAssistantProjectCleanupReport()).toMatchObject({ total: 0, retained: [], removed: [] });
    await expect(migrateAssistantProject(candidate())).rejects.toThrow('owner mismatch');
    await runPendingAssistantProjectCleanup(true);
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
  });

  it('records candidates idempotently and does not overwrite an exact owner confirmation', async () => {
    state.mounted = true;
    await migrateAssistantProject({ ...candidate(), ownerConfirmed: { projectId: 'old', path } });
    noteAssistantProjectCandidate(candidate());
    expect((await getAssistantProjectCleanupReport()).retained[0]).toMatchObject({ ownerConfirmed: { projectId: 'old', path } });
  });

  it('invalidates a queued owner confirmation when the person claims the project before restart', async () => {
    state.mounted = true;
    await migrateAssistantProject({ ...candidate(), ownerConfirmed: { projectId: 'old', path } });
    origin('person'); state.mounted = false;
    await runPendingAssistantProjectCleanup(true);
    expect(readProjects().some(row => row.id === 'old')).toBe(true);
    expect((await getAssistantProjectCleanupReport()).retained[0]).toMatchObject({ reason: 'confirmation-stale' });
    expect((await getAssistantProjectCleanupReport()).retained[0]).not.toHaveProperty('ownerConfirmed');
  });

  it('does not carry an approval across a changed assistant binding', async () => {
    state.mounted = true;
    await migrateAssistantProject({ ...candidate(), ownerConfirmed: { projectId: 'old', path } });
    noteAssistantProjectCandidate({ ...candidate(), assistantId: 'replacement-agent' });
    expect((await getAssistantProjectCleanupReport()).retained[0]).not.toHaveProperty('ownerConfirmed');
  });
});
