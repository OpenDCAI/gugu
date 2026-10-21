import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Check, Undo2 } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/lib/ui/tooltip';

export type ProjectSettingsSaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface ProjectSettingsFooterProps {
  dirty: boolean;
  saveStatus: ProjectSettingsSaveStatus;
  canShareConfig: boolean;
  shareDisabled: boolean;
  onShare: () => void;
  onUndo: () => void;
  onSave: () => void;
}

export function ProjectSettingsFooter({
  dirty,
  saveStatus,
  canShareConfig,
  shareDisabled,
  onShare,
  onUndo,
  onSave,
}: ProjectSettingsFooterProps) {
  const { translate } = useSessionMessages();
  const saving = saveStatus === 'saving';
  const saved = saveStatus === 'saved' && !dirty;
  const saveDisabled = saving || !dirty;

  return (
    <div className="flex justify-between gap-2 pt-5">
      <TooltipProvider delay={150}>
        <Tooltip>
          <TooltipTrigger render={
            <Button
              type="button"
              variant="outline"
              className="shrink-0 gap-1.5 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              aria-disabled={shareDisabled || undefined}
              hidden={!canShareConfig}
              onClick={() => {
                if (shareDisabled) return;
                onShare();
              }}
            >
              {translate('projects.settings.shareWithTeam')}
            </Button>
          } />
          <TooltipContent side="bottom" align="end">
            {translate('projects.settings.shareTooltip')}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-md"
          aria-label={translate('projects.settings.resetChanges')}
          onClick={onUndo}
          disabled={!dirty || saving}
        >
          <Undo2 />
        </Button>
        <ConfirmButton onClick={onSave} disabled={saveDisabled}>
          <span className="inline-flex min-w-22 items-center justify-center gap-1.5">
            {saving && <LoadingIndicator size="inline" />}
            {!saving && saved && <Check className="size-4" aria-hidden="true" />}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save settings'}
          </span>
        </ConfirmButton>
      </div>
    </div>
  );
}
