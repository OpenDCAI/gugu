import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineRegistry } from '@renderer/lib/machine-routing';
import type { sessionViewKind } from './stores/session-selectors';
import { machineUnavailableLabel } from './machine-unavailable-label';

/** Input does not depend on metadata that can only arrive from the unavailable host. */
export function offlineSessionInputTarget(projectId: string, kind: ReturnType<typeof sessionViewKind>) {
  const needsWorkspace = kind === 'project-mounting' || kind === 'provisioning' || kind === 'idle'
    || kind === 'provision-error' || kind === 'project-error';
  if (!needsWorkspace) return null;
  const deviceId = machineRegistry.machineOf(projectId);
  const label = machineUnavailableLabel(projectId);
  return deviceId && label && !remoteHostsStore.cloudScope(deviceId) ? { deviceId, label } : null;
}
