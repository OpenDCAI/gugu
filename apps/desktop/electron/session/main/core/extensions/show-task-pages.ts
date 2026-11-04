import type { BridgeCaller } from './extension-bridge';

type Dependencies = {
  authorize(extensionId: string): void;
  projectOf(sessionId: string): Promise<string>;
  open(target: { projectId: string; sessionId: string }, extensionId: string, signal: AbortSignal): Promise<string[]>;
};

/** Bring up this App's declared per-task pages; the App decides when, the host decides where. */
export async function showTaskPages(caller: BridgeCaller, deps: Dependencies): Promise<string[]> {
  if (caller.kind !== 'program' || !caller.callingSession || !caller.signal) throw new Error('Opening task pages needs a current task program call');
  caller.signal.throwIfAborted(); deps.authorize(caller.extensionId);
  const sessionId = caller.callingSession;
  const projectId = await deps.projectOf(sessionId);
  caller.signal.throwIfAborted(); deps.authorize(caller.extensionId);
  return deps.open({ projectId, sessionId }, caller.extensionId, caller.signal);
}
