import { SessionBootTasks } from '@gugu/core/shared/sessionBootTasks';
import { log } from '@main/lib/logger';

// Owned by the backend bundle. The host uses this SAME instance through emdash-main-bridge.
export const sessionBootTasks = new SessionBootTasks((failure) => {
  log.warn('task boot operation failed; other tasks and host continue', failure);
});
