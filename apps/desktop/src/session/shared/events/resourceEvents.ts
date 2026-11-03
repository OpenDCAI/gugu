import { defineEvent } from '@shared/lib/ipc/events';
import type { ResourceSnapshot } from '@shared/resource-monitor';

export type ResourceSamplingFailure = {
  timestamp: number;
  reason: 'process-list-read-failed' | 'sample-failed';
};
export type ResourceMonitorUpdate = ResourceSnapshot | { samplingError: ResourceSamplingFailure } | null;
/** Failures retain the preceding sample, explicitly marked stale; null means monitoring is unavailable. */
export const resourceSnapshotChannel = defineEvent<ResourceMonitorUpdate>('resource-monitor:snapshot');
