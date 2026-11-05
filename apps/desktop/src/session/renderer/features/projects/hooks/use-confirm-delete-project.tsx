import { ensureProjectHostReady } from '@renderer/features/remote-hosts/ensure-cloud-host-ready';
import { cloudWakeFailureText } from '@renderer/features/remote-hosts/connection-status';
import { cloudComputerWakeFailureOf, findRemoteHostsBridge } from '@/session/shared/remote-hosts';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { rendererLogger } from '@/lib/log';
import { messageForUser } from '@/lib/userFacingError';
import { withTimeout } from '@/lib/withTimeout';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';

async function listProjectAutomations(projectId: string, timeoutMessage: string): Promise<Automation[]> {
  return withTimeout(rpc.automations.listAutomations(projectId), 3000, timeoutMessage);
}

// The project label and the automation names are user data, interpolated or
// listed verbatim.
function deleteProjectDescription(
  projectLabel: string,
  automations: Automation[],
  translate: ProjectsTranslate
) {
  const headline = translate('projects.delete.description', { projectLabel });
  if (automations.length === 0) return headline;

  return (
    <div className="space-y-3">
      <p>{headline}</p>
      <div className="space-y-2">
        <p className="text-foreground-muted">
          {translate('projects.delete.detachWarning', { count: automations.length })}
        </p>
        <ul className="max-h-32 space-y-1 overflow-auto rounded-md border border-border bg-background-secondary p-2 text-sm">
          {automations.map((automation) => (
            <li key={automation.id} className="truncate">
              {automation.name}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function useConfirmDeleteProject() {
  const { translate } = useSessionMessages();
  const showConfirmDeleteProject = useShowModal('confirmActionModal');
  const reportError = (error: unknown, projectIdForError: string) => {
    rendererLogger('actions/delete-project').error({ error }, 'action failed');
    const deviceId = machineRegistry.machineOf(projectIdForError);
    const device = findRemoteHostsBridge()?.listDevices().find(row => row.id === deviceId);
    const description = error && typeof error === 'object' && 'reason' in error
      && (error.reason === 'refused' || error.reason === 'failed' || error.reason === 'timeout')
      ? cloudWakeFailureText(cloudComputerWakeFailureOf(error), device?.label ?? '', translate)
      : messageForUser(error);
    toast({ tier: 'error', title: translate('projects.delete.failed'), description });
  };

  return async ({
    projectId,
    projectLabel,
    onDeleted,
  }: {
    projectId: string;
    projectLabel: string;
    onDeleted?: () => void;
  }) => {
    let checked = false;
    const args = {
      title: translate('projects.delete.title'),
      confirmLabel: translate('projects.delete.confirm'),
      onSuccess: async () => {
        if (!checked) return;
        try {
          await getProjectManagerStore().deleteProject(projectId);
          onDeleted?.();
        } catch (error) {
          reportError(error, projectId);
        }
      },
    };
    // Own a visible, cancellable dialog before any host/automation I/O. A late result may
    // update only this request, never reopen a dismissed dialog or replace a newer one.
    showConfirmDeleteProject({
      ...args,
      confirmDisabled: true,
      description: <div className="space-y-3">
        <p>{translate('projects.delete.description', { projectLabel })}</p>
        <p role="status" className="text-foreground-muted">{translate('projects.delete.checking')}</p>
      </div>,
    });
    const pending = modalStore.activeModalArgs;
    try {
      await ensureProjectHostReady(projectId);
      if (modalStore.activeModalArgs !== pending) return;
      const automations = await listProjectAutomations(projectId, translate('projects.delete.checkTimeout'));
      if (modalStore.activeModalArgs !== pending) return;
      checked = true;
      showConfirmDeleteProject({ ...args, description: deleteProjectDescription(projectLabel, automations, translate) });
    } catch (error) {
      if (modalStore.activeModalArgs !== pending) return;
      pending?.onClose();
      reportError(error, projectId);
    }
  };
}
