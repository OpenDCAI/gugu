import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions, workspaces } from '@main/db/schema';
import { computeWorkspaceKey } from '@main/core/workspaces/workspace-key';
import { projectPathKey } from '../path-utils';
import { resolveAgentSessionProject } from './resolve-agent-session-project';
import { getProjectById } from './getProjects';
import { isImplicitSessionHomeProjectId } from '@shared/core/projects/session-home-project';

/** A task's execution directory is a workspace, not another project registration. */
export async function resolveAssistantSessionWorkspace(directory: string, identity?: { sessionId?: string; assistantId: string; deviceId: string; ownerId: string }) {
  const path = projectPathKey(directory);
  if (!statSync(path).isDirectory()) throw new Error(`Not a task directory: ${path}`);
  if (identity?.sessionId) {
    const existing = db.select().from(sessions).where(eq(sessions.id, identity.sessionId)).get();
    if (existing?.workspaceId) {
      const cwd = db.select({ path: workspaces.path }).from(workspaces).where(eq(workspaces.id, existing.workspaceId)).get();
      if (!cwd?.path || projectPathKey(cwd.path) !== path) throw new Error('Assistant execution directory changed');
    }
    if (existing && !isImplicitSessionHomeProjectId(existing.projectId)) {
      const legacy = await getProjectById(existing.projectId);
      if (!legacy || !existing.workspaceId) throw new Error('Assistant task context is unavailable');
      const { noteAssistantProjectCandidate } = await import('./assistant-project-cleanup');
      noteAssistantProjectCandidate({ ...identity, sessionId: existing.id, projectId: legacy.id, path });
      // Unknown legacy ownership is retained until proven/confirmed and migrated at cold start.
      return { project: legacy, workspaceId: existing.workspaceId, path };
    }
  }
  const project = await resolveAgentSessionProject('');
  const key = computeWorkspaceKey(path);
  const workspaceId = db.transaction((tx) => {
    const found = tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.key, key)).get();
    if (found) return found.id;
    const id = randomUUID();
    tx.insert(workspaces).values({ id, key, path, kind: 'path', type: 'local', location: 'local' }).run();
    return id;
  });
  return { project, workspaceId, path };
}
