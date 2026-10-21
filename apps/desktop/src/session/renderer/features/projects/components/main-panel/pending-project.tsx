import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { AlertCircle, Check, X } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { type UnregisteredProject } from '@renderer/features/projects/stores/project';
import { getProjectManagerStore } from '@renderer/features/projects/stores/project-selectors';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

type Stage = 'creating-repo' | 'cloning' | 'registering';

const STAGE_LABEL_KEYS: Record<Stage, SessionMessageKey> = {
  'creating-repo': 'projects.pending.creatingRepo',
  cloning: 'projects.pending.cloning',
  registering: 'projects.pending.registering',
};

const STAGES_BY_MODE: Record<'pick' | 'clone' | 'new', Stage[]> = {
  pick: ['registering'],
  clone: ['cloning', 'registering'],
  new: ['creating-repo', 'cloning', 'registering'],
};

export const PendingProjectStatus = observer(function PendingProjectStatus({
  project,
}: {
  project: UnregisteredProject;
}) {
  const { navigate } = useNavigate();
  const { translate } = useSessionMessages();
  const stages = STAGES_BY_MODE[project.mode];
  const currentStageIndex = stages.indexOf(project.phase as Stage);
  const isError = project.phase === 'error';

  const handleDismiss = () => {
    getProjectManagerStore().removeUnregisteredProject(project.id);
    navigate('home');
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-6 p-8">
      <div className="flex w-full max-w-sm min-w-0 flex-col items-center gap-3 text-center">
        <h2 className="mb-2 text-base">{project.name}</h2>

        {stages.map((stage, i) => {
          const isDone = !isError && i < currentStageIndex;
          const isActive = !isError && stage === project.phase;
          return (
            <div key={stage} className="flex items-center justify-center gap-3">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                {isDone ? (
                  <Check className="h-4 w-4 text-foreground-success" />
                ) : isActive ? (
                  <LoadingIndicator size="inline" className="text-foreground-muted" />
                ) : (
                  <div className="bg-foreground-muted/30 h-2 w-2 rounded-full" />
                )}
              </div>
              <span
                className={
                  isActive
                    ? 'text-sm font-medium text-foreground'
                    : isDone
                      ? 'text-foreground-muted text-sm'
                      : 'text-foreground-muted/50 text-sm'
                }
              >
                {translate(STAGE_LABEL_KEYS[stage])}
              </span>
            </div>
          );
        })}

        {isError && (
          <div className="border-border-destructive bg-background-destructive mt-2 flex w-full min-w-0 flex-col gap-3 rounded-md border p-3">
            <div className="flex min-w-0 items-start gap-2 text-left">
              <AlertCircle className="text-foreground-destructive mt-0.5 h-4 w-4 shrink-0" />
              <span className="text-foreground-destructive min-w-0 text-sm break-words">
                {/* A backend failure reason is raw diagnostic text. */}
                {project.error ?? translate('projects.pending.genericError')}
              </span>
            </div>
            <Button size="sm" variant="outline" className="self-center" onClick={handleDismiss}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {translate('projects.pending.dismiss')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
});
