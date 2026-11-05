import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';
import { admitFirstMessages } from './session-life-creation';

async function provisionWorkspace(sessionId: string, options?: { deferFirstTurn?: boolean }) {
  const result = await sessionService.provisionWorkspace(sessionId);
  if (result.success && !options?.deferFirstTurn) await admitFirstMessages(sessionId);
  return result;
}

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  /** One device crossing for creation, workspace preparation and admission of the first turn. */
  async createAndProvisionSession(params: CreateSessionParams, options?: { deferFirstTurn?: boolean }) {
    const created = await sessionService.createSession(params);
    if (!created.success) return { stage: 'create' as const, result: created };
    const sessionId = params.sessionConfig.initialSession!.id;
    try {
      return { stage: 'provision' as const, result: await provisionWorkspace(sessionId, options) };
    } catch (error) {
      // The row exists. A retry prepares that row, rather than creating another task.
      return { stage: 'provision-error' as const, message: error instanceof Error ? error.message : String(error) };
    }
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  // The desktop task page's launch of the session it just created: workspace first, then its creation turns.
  provisionWorkspace,
  admitFirstMessages,
  generateSessionName,
});
