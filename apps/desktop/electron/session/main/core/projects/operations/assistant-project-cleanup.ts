import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray, isNull, like, or } from 'drizzle-orm';
import { resolveGuguHome } from '@gugu/core/local/state/paths';
import { db, type AppDb, type DrizzleTx } from '@main/db/client';
import { automations, editorBuffers, kv, projectRemotes, projects, projectSettings, sessions, terminals, workspaces } from '@main/db/schema';
import { sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager';
import { projectEvents } from '../project-events';
import { log } from '@main/lib/logger';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';
import { projectPathKey } from '../path-utils';
import { readProjectRegistration } from './project-registration-origin';
import { resolveAgentSessionProject } from './resolve-agent-session-project';
import { projectGroupHost } from '../project-group-host';
import { isAppKeptDirectory } from '../app-kept-directory';

const PREFIX = 'assistant-project-cleanup:';
export type AssistantProjectCandidate = {
  projectId: string; path: string; sessionId: string; assistantId: string; deviceId: string; ownerId: string;
  /** Only an explicit, exact-record owner action may set this. */
  ownerConfirmed?: { projectId: string; path: string; createdAt?: string; originFingerprint?: string };
};
export type AssistantProjectCleanupEntry = AssistantProjectCandidate & {
  status: 'retained' | 'removed'; reason: string; backup?: string; taskProjectId?: string;
};
const keyOf = (projectId: string) => PREFIX + projectId;
let currentOwner: (() => Promise<string | null>) | null = null;
let currentDevice: (() => Promise<string | null>) | null = null;
const attemptedOwners = new Set<string>();
const running = new Map<string, Promise<void>>();
let databaseReady = false;
export function setAssistantProjectCleanupOwner(read: () => Promise<string | null>, device?: () => Promise<string | null>) {
  currentOwner = read;
  currentDevice = device ?? null;
  attemptedOwners.clear();
}
function store(entry: AssistantProjectCleanupEntry) {
  const key = keyOf(entry.projectId), value = JSON.stringify(entry);
  db.insert(kv).values({ key, value, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } }).run();
}

/** Called only after the host has verified the provision's personal-assistant role. */
export function noteAssistantProjectCandidate(candidate: AssistantProjectCandidate): void {
  if (isImplicitSessionHomeProjectId(candidate.projectId)) return;
  const old = db.select({ value: kv.value }).from(kv).where(eq(kv.key, keyOf(candidate.projectId))).get();
  if (old) {
    const prior = JSON.parse(old.value) as AssistantProjectCleanupEntry;
    if (['path', 'sessionId', 'assistantId', 'deviceId', 'ownerId'].every(key =>
      prior[key as keyof AssistantProjectCandidate] === candidate[key as keyof AssistantProjectCandidate])) return;
  }
  store({ ...candidate, status: 'retained', reason: 'pending-inspection' });
}

function storedEntries() {
  return db.select({ value: kv.value }).from(kv).where(like(kv.key, `${PREFIX}%`)).all()
    .map(row => JSON.parse(row.value) as AssistantProjectCleanupEntry);
}
export async function getAssistantProjectCleanupReport() {
  const ownerId = await currentOwner?.();
  if (!ownerId) throw new Error('Assistant project cleanup requires the signed-in owner');
  const allEntries = storedEntries();
  const entries = allEntries.filter(entry => entry.ownerId === ownerId);
  const deviceId = await currentDevice?.();
  if (!deviceId) throw new Error('Assistant project cleanup device is unavailable');
  const recorded = new Set(allEntries.filter(entry => entry.status === 'retained').map(entry => entry.projectId));
  // Also expose old app-directory registrations that have no surviving assistant
  // binding. They are inventory only: no inferred identity and no automatic removal.
  const unbound = db.select().from(projects).where(isNull(projects.archivedAt)).all()
    .filter(row => !isImplicitSessionHomeProjectId(row.id) && !recorded.has(row.id))
    .filter(row => { try { return isAppKeptDirectory(row.path); } catch { return false; } })
    .map(row => ({ projectId: row.id, path: row.path, deviceId, ownerId, status: 'retained' as const,
      reason: readProjectRegistration(row.id)?.source === 'person' ? 'person-created-or-claimed' : 'unbound-origin-unproven' }));
  const retained = [...entries.filter(entry => entry.status === 'retained'), ...unbound];
  return { deviceId, total: retained.length, retained, removed: entries.filter(entry => entry.status === 'removed') };
}

function snapshot(projectId: string, tx: AppDb | DrizzleTx = db) {
  const project = tx.select().from(projects).where(eq(projects.id, projectId)).get();
  const tasks = tx.select().from(sessions).where(eq(sessions.projectId, projectId)).orderBy(sessions.id).all();
  const ids = tasks.flatMap(row => row.workspaceId ? [row.workspaceId] : []);
  if (project?.repositoryWorkspaceId) ids.push(project.repositoryWorkspaceId);
  const directories = tx.select().from(workspaces).where(or(eq(workspaces.projectId, projectId),
    ids.length ? inArray(workspaces.id, ids) : undefined)).orderBy(workspaces.id).all();
  const schedules = tx.select().from(automations).where(eq(automations.projectId, projectId)).orderBy(automations.id).all();
  const inbox = tasks.flatMap(task => tx.select().from(kv).where(eq(kv.key, `native-conversation-inbox:${task.id}`)).all());
  const settings = tx.select().from(projectSettings).where(eq(projectSettings.projectId, projectId)).get();
  const terminalRows = tx.select().from(terminals).where(eq(terminals.projectId, projectId)).orderBy(terminals.id).all();
  const buffers = tx.select().from(editorBuffers).where(eq(editorBuffers.projectId, projectId)).orderBy(editorBuffers.id).all();
  const remotes = tx.select().from(projectRemotes).where(eq(projectRemotes.projectId, projectId)).orderBy(projectRemotes.remoteName).all();
  return { project, tasks, directories, schedules, inbox, settings, terminalRows, buffers, remotes };
}
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function replaceProject<T>(value: T, from: string, to: string): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value, (key, item: unknown) =>
    (key === 'projectId' || key === 'project_id') && item === from ? to : item)) as T;
}

/** Never calls deleteProject/archiveSession, never removes or rewrites a directory. */
export async function migrateAssistantProject(input: AssistantProjectCandidate): Promise<AssistantProjectCleanupEntry> {
  let candidate = input;
  if (!currentOwner || await currentOwner() !== candidate.ownerId) throw new Error('Assistant project cleanup owner mismatch');
  if (currentDevice && await currentDevice() !== candidate.deviceId) throw new Error('Assistant project cleanup device mismatch');
  const retained = async (reason: string, backup?: string): Promise<AssistantProjectCleanupEntry> => {
    const entry = { ...candidate, status: 'retained' as const, reason, ...(backup ? { backup } : {}) };
    store(entry);
    log.warn('assistant-project-cleanup: retained', { total: (await getAssistantProjectCleanupReport()).total, ...entry });
    return entry;
  };
  if (isImplicitSessionHomeProjectId(candidate.projectId)) throw new Error('Cannot remove the task workspace');
  const before = snapshot(candidate.projectId);
  if (!before.project) {
    const entry = { ...candidate, status: 'removed' as const, reason: 'already-removed' };
    store(entry);
    return entry;
  }
  if (before.project.archivedAt && before.tasks.length === 0) {
    const prior = (await getAssistantProjectCleanupReport()).removed.find(entry => entry.projectId === candidate.projectId);
    if (prior) return prior;
  }
  if (projectPathKey(before.project.path) !== projectPathKey(candidate.path)) return retained('path-changed');
  const own = before.tasks.find(row => row.id === candidate.sessionId);
  if (!own || !before.directories.some(row => row.id === own.workspaceId && row.path && projectPathKey(row.path) === projectPathKey(candidate.path))) {
    return retained('assistant-binding-changed');
  }
  const confirmed = candidate.ownerConfirmed?.projectId === candidate.projectId
    && candidate.ownerConfirmed.path === candidate.path;
  const origin = readProjectRegistration(candidate.projectId);
  if (confirmed) {
    const approval = candidate.ownerConfirmed!;
    if ((approval.createdAt !== undefined && approval.createdAt !== before.project.createdAt)
      || (approval.originFingerprint !== undefined && approval.originFingerprint !== fingerprint(origin))) {
      candidate = { ...candidate, ownerConfirmed: undefined };
      return retained('confirmation-stale');
    }
    candidate = { ...candidate, ownerConfirmed: { ...approval, createdAt: before.project.createdAt, originFingerprint: fingerprint(origin) } };
  }
  if (!confirmed && (!origin || origin.source !== 'automatic' || origin.path !== before.project.path || origin.createdAt !== before.project.createdAt)) {
    return retained(origin?.source === 'person' ? 'person-created-or-claimed' : 'legacy-origin-unknown');
  }
  if (!confirmed && before.directories.some(row => row.attachedAt !== null)) return retained('person-added-folders');
  if (!confirmed) {
    const family = new Set([candidate.sessionId]);
    for (let size = -1; size !== family.size;) {
      size = family.size;
      for (const row of before.tasks) if ((row.parentSessionId && family.has(row.parentSessionId))
        || (row.spawnedBySessionId && family.has(row.spawnedBySessionId))) family.add(row.id);
    }
    if (before.tasks.some(row => !family.has(row.id))) return retained('other-task-uses-project');
  }
  if (!confirmed && (before.project.baseRef !== null || (before.settings && before.settings.baseProjectSettingsJson !== '{}'))) {
    return retained('project-customized');
  }
  // Query this exact ID, including legacy rows whose old kind was "workspace".
  const groups = await projectGroupHost().listBindings([candidate.projectId]);
  if (!groups.success) return retained('group-binding-unavailable');
  if (!confirmed && groups.data.some(row => row.projectId === candidate.projectId)) return retained('project-group-bound');

  const directory = join(resolveGuguHome(), 'backups', 'assistant-project-registrations');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backup = join(directory, `${candidate.projectId}-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(backup, `${JSON.stringify({ version: 1, candidate, before }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  // A running/mounted task must not have its project changed underneath its lifecycle owner.
  // Keep the request for the cold-start pass instead of stopping an owner's agent.
  if (before.tasks.some(row => sessionWorkspaceManager.getSession(row.id))) return retained('pending-restart', backup);
  const taskProject = await resolveAgentSessionProject('');
  if (await currentOwner() !== candidate.ownerId) throw new Error('Assistant project cleanup account changed');
  const changed = db.transaction(tx => {
    const current = snapshot(candidate.projectId, tx);
    if (fingerprint(current) !== fingerprint(before)) return false;
    const currentOrigin = readProjectRegistration(candidate.projectId, tx);
    if (fingerprint(currentOrigin) !== fingerprint(origin)) return false;
    const buffers = current.buffers.map(row => ({ row, id: row.id.startsWith(`${candidate.projectId}:`)
      ? `${taskProject.id}:${row.id.slice(candidate.projectId.length + 1)}` : row.id }));
    if (buffers.some(({ row, id }) => id !== row.id && tx.select({ id: editorBuffers.id }).from(editorBuffers).where(eq(editorBuffers.id, id)).get())) return false;
    for (const row of current.tasks) tx.update(sessions).set({ projectId: taskProject.id,
      config: replaceProject(row.config, candidate.projectId, taskProject.id) }).where(eq(sessions.id, row.id)).run();
    for (const row of current.schedules) tx.update(automations).set({ projectId: taskProject.id,
      agentConfig: replaceProject(row.agentConfig, candidate.projectId, taskProject.id),
      sessionConfig: replaceProject(row.sessionConfig, candidate.projectId, taskProject.id),
    }).where(eq(automations.id, row.id)).run();
    for (const row of current.terminalRows) tx.update(terminals).set({ projectId: taskProject.id }).where(eq(terminals.id, row.id)).run();
    for (const { row, id } of buffers) tx.update(editorBuffers).set({ id, projectId: taskProject.id }).where(eq(editorBuffers.id, row.id)).run();
    for (const row of current.inbox) tx.update(kv).set({ value: JSON.stringify(replaceProject(JSON.parse(row.value) as unknown,
      candidate.projectId, taskProject.id)) }).where(eq(kv.key, row.key)).run();
    // Keep every workspace ID and exact path. A former root is now a task directory.
    for (const row of current.directories) {
      if (row.id === current.project?.repositoryWorkspaceId || row.projectId === candidate.projectId) {
        tx.update(workspaces).set({ kind: 'path', projectId: null, attachedAt: null }).where(eq(workspaces.id, row.id)).run();
      }
    }
    // Keep the historical row and its settings/remotes for rollback. It is no longer
    // a registered project: ordinary inventory/publication excludes archived rows.
    tx.update(projects).set({ archivedAt: new Date().toISOString(), rootFolderDetached: true })
      .where(eq(projects.id, candidate.projectId)).run();
    return true;
  });
  if (!changed) return retained('concurrent-change', backup);
  const entry: AssistantProjectCleanupEntry = { ...candidate, status: 'removed', reason: confirmed ? 'owner-confirmed' : 'proven-automatic', backup, taskProjectId: taskProject.id };
  store(entry);
  projectEvents._emit('project:deleted', candidate.projectId);
  log.warn('assistant-project-cleanup: registration removed, files retained', entry);
  return entry;
}

/** Run after SQLite initialization and before task/project restoration. */
export async function runPendingAssistantProjectCleanup(databaseInitialized = false): Promise<void> {
  databaseReady ||= databaseInitialized;
  if (!databaseReady) return;
  const ownerId = await currentOwner?.();
  if (!ownerId) return;
  const prior = running.get(ownerId);
  if (prior) return prior;
  if (attemptedOwners.has(ownerId)) return;
  attemptedOwners.add(ownerId);
  const pending = (async () => {
    for (const entry of storedEntries().filter(entry => entry.ownerId === ownerId && entry.status === 'retained')) {
      try { await migrateAssistantProject(entry); }
      catch (error) { log.error('assistant-project-cleanup: failed; registration retained', { projectId: entry.projectId, error: String(error) }); }
    }
  })();
  running.set(ownerId, pending);
  try { await pending; } finally { running.delete(ownerId); }
}
