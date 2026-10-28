import { sessionStateSchema, sessionSummarySchema, type SessionState, type SessionSummary } from '@gugu/session-core/acp';
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

/**
 * 一条活会话此刻在运行时里的状态(`session.state`)。会话不在运行时里 = null(读它的 cell 会 NOT_FOUND,
 * 先看 `sessions.list` 再订,同 live-permissions)。
 */
export async function readAcpSessionState(sessionId: string): Promise<SessionState | null> {
  const summary = Object.values(await readAcpSessionSummaries()).find((row) => row.sessionId === sessionId);
  if (!summary || summary.lifecycle === 'closed' || summary.lifecycle === 'lost') return null;
  const handle = await initializeAcpRuntimeProcess();
  const replica = new ReplicaState<SessionState>(handle.client.session.state({ sessionId }, 'state'), { schema: sessionStateSchema });
  try {
    await replica.ready;
    return replica.current();
  } finally {
    void replica.dispose();
  }
}
