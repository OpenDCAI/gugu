import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';

async function listProjectAutomations(projectId: string): Promise<Automation[]> {
  return rpc.automations.listAutomations(projectId).catch(() => []);
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

  return async ({
    projectId,
    projectLabel,
    onDeleted,
  }: {
    projectId: string;
    projectLabel: string;
    onDeleted?: () => void;
  }) => {
    const automations = await listProjectAutomations(projectId);

    showConfirmDeleteProject({
      title: translate('projects.delete.title'),
      description: deleteProjectDescription(projectLabel, automations, translate),
      confirmLabel: translate('projects.delete.confirm'),
      onSuccess: () => {
        void getProjectManagerStore().deleteProject(projectId);
        onDeleted?.();
      },
    });
  };
}
