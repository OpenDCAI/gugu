import { defineEvent } from '@shared/lib/ipc/events';
import type { ResourceSnapshot } from '@shared/resource-monitor';

/** Null ends an unsuccessful sample without replacing the last valid snapshot. */
export const resourceSnapshotChannel = defineEvent<ResourceSnapshot | null>('resource-monitor:snapshot');
