import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';
import { admitFirstMessages } from './session-life-creation';

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  // The desktop task page's launch of the session it just created: workspace first, then its creation turns.
  async provisionWorkspace(sessionId: string, options?: { deferFirstTurn?: boolean }) {
    const result = await sessionService.provisionWorkspace(sessionId);
    if (result.success && !options?.deferFirstTurn) await admitFirstMessages(sessionId);
    return result;
  },
  admitFirstMessages,
  generateSessionName,
});
