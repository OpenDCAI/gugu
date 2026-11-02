import { buildSystemNoticeEnvelope, formatDeliveryTimestamp } from '@gugu/core/local/agent/deliveryEnvelope';
import type { LastExit } from '../../../../lib/exit-reason';
import { stableUuid } from '../sessions/session-direct-identity';
import { sessionBootTasks } from '../boot-tasks';

/** After boot recovery and message delivery are ready, wake only work interrupted by an update. */
export async function resumeHostUpdate(sessionIds: readonly string[], lastExit: LastExit, version: string): Promise<void> {
  if (lastExit.reason !== 'update' || sessionIds.length === 0) return;
  const { messageSessionFrom } = await import('../sessions/session-orchestration');
  const at = formatDeliveryTimestamp(new Date(lastExit.at).toISOString());
  const text = `Your work was interrupted at ${at} because Gugu on this machine restarted to update to ${version}. Commands that were running did not report back; check their state, then continue from where you stopped.`;
  await Promise.all(sessionIds.map(sessionId => sessionBootTasks.run('update-resume', sessionId, () => messageSessionFrom(
    (messageId, content) => buildSystemNoticeEnvelope({ messageId, content, at }),
    sessionId, text, { keyScope: 'host:update', receipt: {
      id: stableUuid(['host:update', 'update-interrupted', String(lastExit.at)]), at: new Date(lastExit.at).toISOString(),
    } },
  ))));
}
