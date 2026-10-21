import { sessionIdOf } from '@shared/extensions/app-runtime-protocol';

/**
 * `gugu.showSession(id)` (#7158): the session comes up as a click on its row in the task list brings it. A session of this
 * computer is found in its database; one of another computer is in the task list or nowhere — #6264 lists the person's
 * other computers' sessions there, from the window's own directory (live, or the last seen while that one is offline) —
 * so the window says which project it lists it under. Either way it comes up the one way a banner's click brings one up.
 */

export interface ShowSessionDeps {
  /** This computer's session as its task list has it: its project, or null — none here, or archived (`sessionHere`). */
  projectHere(sessionId: string): Promise<string | null>;
  /** The project the window's task list has another computer's session under, or null (renderer command; may fail). */
  projectListed(sessionId: string): Promise<string | null>;
  /** Bring the session up (the way an agent's banner brings its session up). */
  bringUp(session: { sessionId: string; projectId: string }): Promise<void>;
}

const coded = (code: 'not-found' | 'failed', message: string) => Object.assign(new Error(message), { code });

export async function showSession(id: unknown, deps: ShowSessionDeps): Promise<void> {
  const sessionId = sessionIdOf(id);
  const projectId =
    (await deps.projectHere(sessionId)) ??
    // A window that cannot answer (not up yet, reloading, gone, past the command's wait) is `failed`, its reason said;
    // an answer that comes after that is nobody's, so nothing comes up late.
    (await deps.projectListed(sessionId).catch((error: unknown) => {
      throw coded('failed', `The task page did not answer (${error instanceof Error ? error.message : String(error)}): try again once it shows`);
    }));
  if (!projectId) throw coded('not-found', `Session ${sessionId} is not on this computer or in your task list`);
  await deps.bringUp({ sessionId, projectId });
}

/**
 * A session of this computer the task list shows: its project. Null for none here, and for an archived one — the list
 * does not show it (任务历史 does), and a session page navigated to it lands on a new task, not on it (#7158 A/B cell 8).
 */
export async function sessionHere(sessionId: string): Promise<string | null> {
  const [{ db }, { sessions }, { eq }] = await Promise.all([import('@main/db/client'), import('@main/db/schema'), import('drizzle-orm')]);
  const [row] = await db
    .select({ projectId: sessions.projectId, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row && !row.archivedAt ? row.projectId : null;
}
