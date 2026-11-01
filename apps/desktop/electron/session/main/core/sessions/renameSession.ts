import { eq } from 'drizzle-orm';
import { agentNameSerial } from '@gugu/core/shared/agentDefaultName';
import { normalizeAgentType } from '@gugu/core/agentTypes';
import { getAgentTypeLabel } from '@gugu/core/shared/enums/agentTypeModels';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { MAX_SESSION_TITLE_LENGTH } from '@shared/core/sessions/sessions';
import { sessionEvents } from './session-events';
import { boundTaskName, onTaskNamesChanged, taskName, taskNamer } from './task-name';

/**
 * Renaming a task renames its one name (task-name.ts): a bound session's identity, otherwise its
 * pending-bind record. A person's rename always applies. An automatic name (the harness's own title,
 * or the name gugu generates from the first turn, #7337) only replaces the engine default, so the
 * first automatic name wins once and a chosen name is never overwritten.
 */
export async function renameSession(sessionId: string, name: string): Promise<void> {
  await renameTask(sessionId, name, 'manual');
}

export async function applyHarnessTitle(sessionId: string, title: string): Promise<boolean> {
  if (isFirstPromptEcho(title, firstUtteranceOf(sessionId))) return false;
  return renameTask(sessionId, title, 'auto');
}

export async function applyGeneratedTitle(sessionId: string, title: string): Promise<boolean> {
  return renameTask(sessionId, title, 'auto');
}

/**
 * Upgrading to one name per task (migration 0043) left a bound task named by its identity, and most
 * identities still carry the engine default (`Claude 127`) while the task showed a title. That old
 * title, kept by 0043 in the legacy `title` column, becomes the name once — as an ordinary automatic
 * rename (pending on this device, then published): a name a person gave is never replaced, the
 * length is capped like every name, and once renamed the identity is no longer a default, so later
 * starts do nothing. Runs after the cloud names are adopted, so a rename made on another device counts.
 */
export async function adoptLegacyTaskNames(): Promise<number> {
  const rows = db
    .select({ id: sessions.id, provider: sessions.provider, legacyTitle: sessions.legacyTitle })
    .from(sessions)
    .all();
  let renamed = 0;
  for (const row of rows) {
    if (!boundTaskName(row.id)) continue; // unbound: 0043 already made the old title its name
    const title = row.legacyTitle.trim();
    // 0043 filled an empty old title with the provider or the session id: that is no name. An old
    // title that is itself an engine default is no task name either (and the cloud may have
    // renumbered the identity's default on purpose).
    if (title === row.provider || title === row.id || isEngineDefault(title, row.provider)) continue;
    if (await renameTask(row.id, title, 'auto')) renamed += 1;
  }
  return renamed;
}

/** Whether the task still carries the engine default — asked before paying for a generated name. */
export function sessionTitleIsFallback(sessionId: string): { fallback: boolean; firstUtterance: string | undefined } {
  const row = readRow(sessionId);
  if (!row) return { fallback: false, firstUtterance: undefined };
  return { fallback: isEngineDefault(taskName(row), row.provider), firstUtterance: row.config?.firstUtterance };
}

async function renameTask(sessionId: string, rawName: string, source: 'manual' | 'auto'): Promise<boolean> {
  const name = collapse(rawName).slice(0, MAX_SESSION_TITLE_LENGTH);
  if (!name) {
    if (source === 'auto') return false; // an empty automatic title is no name
    throw new Error(`Session ${sessionId} cannot be renamed to an empty name`);
  }
  const row = readRow(sessionId);
  if (!row) throw new Error(`Session ${sessionId} not found`);
  const current = taskName(row);
  if (current === name) return false;
  if (source === 'auto' && !isEngineDefault(current, row.provider)) return false;
  const bound = boundTaskName(sessionId);
  if (bound) {
    // The roster write announces the new name (onTaskNamesChanged); publication follows.
    await taskNamer().renameBound(sessionId, bound.agentUserId, name, source);
    return true;
  }
  db.update(sessions)
    .set({ config: { ...row.config!, agentDisplayName: name } })
    .where(eq(sessions.id, sessionId))
    .run();
  announceTaskName(sessionId, row.projectId, name);
  return true;
}

/** Search and every renderer follow one announcement per name change. */
export function announceTaskName(sessionId: string, projectId: string, name: string): void {
  sessionEvents._emit('session:renamed', sessionId, projectId, name);
  events.emit(sessionChangedChannel, { sessionId, projectId, changes: { title: name } });
}

function readRow(sessionId: string) {
  return db
    .select({ id: sessions.id, projectId: sessions.projectId, provider: sessions.provider, config: sessions.config })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
    .get();
}

function firstUtteranceOf(sessionId: string): string | undefined {
  return readRow(sessionId)?.config?.firstUtterance;
}

function isEngineDefault(name: string, provider: string | null): boolean {
  return agentNameSerial(name, getAgentTypeLabel(normalizeAgentType(provider ?? ''))) !== null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * A harness "name" that is only the first prompt echoed back (Claude's ACP bridge falls back to the
 * summary, Copilot's default is the first message) is not a name. A wrapped first turn comes back as
 * its envelope tag.
 */
function isFirstPromptEcho(title: string, firstUtterance: string | undefined): boolean {
  if (/^<[a-z_][\w-]*[\s>]/i.test(title)) return true;
  const prompt = collapse(firstUtterance ?? '');
  if (!prompt) return false;
  const head = title.replace(/(…|\.\.\.)$/, '').trimEnd();
  return head === prompt
    || (head.length >= 40 && prompt.startsWith(head))
    || (prompt.length >= 20 && head.startsWith(prompt));
}

// A bound name changed on the roster (rename here, publish, another device, provisioning). The task has
// one name at a time: binding clears the pending-bind record; unbinding (archive, removal) writes the
// identity's last name back into it, which is also the name a restored task's new identity takes.
onTaskNamesChanged((changes) => {
  for (const { sessionId, previous, next } of changes) {
    const row = readRow(sessionId);
    if (!row) continue;
    if (next && row.config?.agentDisplayName !== undefined) {
      const { agentDisplayName: _bound, ...config } = row.config;
      db.update(sessions).set({ config }).where(eq(sessions.id, sessionId)).run();
    }
    if (!next && previous && row.config?.agentDisplayName !== previous.name) {
      db.update(sessions).set({ config: { ...row.config!, agentDisplayName: previous.name } }).where(eq(sessions.id, sessionId)).run();
    }
    announceTaskName(sessionId, row.projectId, next?.name ?? previous!.name);
  }
});
