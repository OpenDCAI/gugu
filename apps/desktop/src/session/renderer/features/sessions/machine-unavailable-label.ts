import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { machineLinkState } from '@renderer/lib/machine-clients';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { workspaceReachLabel } from './workspace-backend/workspace-surface';

/** Preparation screens and action notifications name the same unavailable machine. */
export function machineUnavailableLabel(projectId: string): string | null {
  const reason = workspaceReachLabel(projectId);
  if (reason) return reason;
  const machine = machineRegistry.machineOf(projectId);
  if (!machine || machineLinkState(machine) === 'open') return null;
  return translateSessionMessage('remoteHost.status.offlineNever', { device: remoteHostsStore.device(machine)?.label ?? machine });
}
