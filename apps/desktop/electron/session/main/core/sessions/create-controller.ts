import type { CreateSessionParams } from '@shared/core/sessions/create-session';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { getProjectWorkspaces } from './operations/getProjectWorkspaces';
import { sessionService } from './session-service';
import { admitFirstMessages } from './session-life-creation';
import { fcp } from '@gugu/session-shared/fcp';

export const sessionCreateController = createRPCController({
  async createSession(params: CreateSessionParams) {
    fcp('main:createSession:start');
    const r = await sessionService.createSession(params);
    fcp('main:createSession:end', { sid: (r as any)?.data?.id ?? (r as any)?.id });
    return r;
  },
  async getProjectWorkspaces(projectId: string) {
    return getProjectWorkspaces(projectId);
  },
  // The desktop task page's launch of the session it just created: workspace first, then its creation turns.
  async provisionWorkspace(sessionId: string, options?: { deferFirstTurn?: boolean }) {
    fcp('main:provisionWorkspace:start', { sid: sessionId });
    const result = await sessionService.provisionWorkspace(sessionId);
    fcp('main:provisionWorkspace:workspaceDone', { sid: sessionId });
    if (result.success && !options?.deferFirstTurn) await admitFirstMessages(sessionId);
    fcp('main:provisionWorkspace:end', { sid: sessionId });
    return result;
  },
  admitFirstMessages,
  generateSessionName,
});
