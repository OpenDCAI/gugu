import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  async provisionWorkspace(sessionId: string) {
    return sessionService.provisionWorkspace(sessionId);
  },
  generateSessionName,
});
