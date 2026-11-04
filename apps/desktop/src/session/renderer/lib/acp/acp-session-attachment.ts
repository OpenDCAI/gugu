import { sessionLifeViewChannel } from '@shared/core/sessions/sessionEvents';
import { onMachineEvent, rpcOn } from '../ipc';
import { machineRegistry } from '../machine-routing';
import { AcpLiveSession } from './acp-live-session';
import { getAcpRuntimeClient } from './runtime-client';
import { attachInCurrentConnection } from './session-attachment';

export async function attachAcpSessionWhenReady(sessionId: string, signal: AbortSignal): Promise<AcpLiveSession> {
  const machine = machineRegistry.machineOf(sessionId);
  const client = await getAcpRuntimeClient(machine);
  return attachInCurrentConnection({
    connection: client.connection,
    readLife: () => rpcOn(machine).sessions.lifeView(sessionId),
    onLife: listener => onMachineEvent(machine, sessionLifeViewChannel, view => {
      if (view.sessionId === sessionId) listener(view);
    }),
    attach: () => AcpLiveSession.create(sessionId),
  }, signal);
}
