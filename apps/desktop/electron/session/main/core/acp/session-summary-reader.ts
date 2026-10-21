import { sessionSummarySchema, type SessionSummary } from '@gugu/session-core/acp';
import { ReplicaState } from '@gugu/session-wire';
import { z } from 'zod';
import { initializeAcpRuntimeProcess } from './controller';

const sessionSummaryListSchema = z.record(z.string(), sessionSummarySchema);

export async function readAcpSessionSummaries(): Promise<Record<string, SessionSummary>> {
  const handle = await initializeAcpRuntimeProcess();
  const replica = new ReplicaState<Record<string, SessionSummary>>(
    handle.client.sessions.state(undefined, 'list'),
    { schema: sessionSummaryListSchema }
  );
  try {
    await replica.ready;
    return replica.current();
  } finally {
    void replica.dispose();
  }
}
