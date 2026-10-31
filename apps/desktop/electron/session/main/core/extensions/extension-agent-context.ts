import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { workspaceRegistry } from '@main/core/workspaces/workspace-registry';
import { sessionModelLabel, sessionPlatformModel } from '@main/core/sessions/platform-model-selection';
import { sessionModelFromDecision } from '@main/core/sessions/session-model-fact';

/**
 * #6615 问题 11 What an extension program is told about the agent session that called it, beyond who
 * (`gugu/agent`): which session it is, and where its working copy is.
 *
 * Why: a program runs with the bundle as its working directory and used to learn nothing about the
 * caller's project, while the same call from the extension's own page already carried `gugu/sessionId`.
 * W-21 measured both harnesses stuck on it — one relayed the path through its page's data folder, the
 * other invented a `GUGU_PROJECT_DIR` variable that does not exist.
 *
 * Read on every call, not frozen at session start: the session id never changes, but its
 * working copy is only known while mounted. `workspaceRoot` is null when it is not — said, not guessed.
 */
export interface AgentSessionContext {
  sessionId: string;
  projectId: string;
  /** The workspace it runs in (`sessions.workspaceId`): what the window reads its files through. */
  workspaceId: string | null;
  workspaceRoot: string | null;
  /**
   * The model gugu runs this session on, as `listAgents()` gives it (`spawn_model_id`: a Gugu model's `platform:<id>`,
   * else the harness's own id). Null when the session never chose one — not guessed. One switched inside the agent's
   * own terminal (`/model`) is not seen: gugu records the choices made through it (session-model-fact.ts).
   */
  model: string | null;
  /** That model's name as the model menu shows it (`sessionModelLabel`, kept with the decision); null for an engine's own. */
  modelLabel: string | null;
}

/**
 * A session on this computer, as main knows it: its project, where its working copy is and its model — the one answer
 * for an App tool call's `_meta` and for every `gugu.files` call naming `{ session }` (真源原则 13). Null: no such session here.
 */
export async function agentSessionContext(agentId: string): Promise<AgentSessionContext | null> {
  const [session] = await db
    .select({ workspaceId: sessions.workspaceId, projectId: sessions.projectId, config: sessions.config, provider: sessions.provider, runtime: sessions.runtime })
    .from(sessions)
    .where(eq(sessions.id, agentId))
    .limit(1);
  if (!session) return null;
  const workspace = session.workspaceId ? workspaceRegistry.get(session.workspaceId) : undefined;
  const decision = await sessionPlatformModel(agentId);
  const model = sessionModelFromDecision(decision, session.config?.model ?? null).spawn_model_id ?? null;
  const modelLabel = await sessionModelLabel(agentId, decision, session.provider, session.runtime);
  return { sessionId: agentId, projectId: session.projectId, workspaceId: session.workspaceId ?? null, workspaceRoot: workspace?.path ?? null, model, modelLabel };
}

