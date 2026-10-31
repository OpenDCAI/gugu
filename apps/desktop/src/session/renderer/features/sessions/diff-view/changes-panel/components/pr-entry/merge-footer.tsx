import { LoadingIndicator } from '@/lib/loading/LoadingIndicator'
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle, type IconComponent } from '@/lib/icons'
import { GitMerge } from '@/lib/icons'
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { SplitButton, type SplitButtonAction } from '@renderer/lib/ui/split-button';
import { cn } from '@renderer/utils/utils';
import { type MergeSeverity, type MergeUiState } from './merge-ui-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

const severityConfig: Record<MergeSeverity, SeverityConfig> = {
  success: { icon: CheckCircle2, iconClass: 'text-foreground-success' },
  warning: { icon: AlertTriangle, iconClass: 'text-foreground-warning' },
  error: { icon: XCircle, iconClass: 'text-foreground-error' },
  neutral: { icon: HelpCircle, iconClass: 'text-foreground-passive' },
};

type SeverityConfig = { icon: IconComponent; iconClass: string };

export function MergeFooter({
  uiState,
  mergeActions,
  isMerging,
  isMarkingReady,
  bypassRequirements,
  onMarkReady,
  onBypassRequirementsChange,
}: {
  uiState: MergeUiState;
  mergeActions: SplitButtonAction[];
  isMerging: boolean;
  isMarkingReady: boolean;
  bypassRequirements: boolean;
  onMarkReady: () => void;
  onBypassRequirementsChange: (checked: boolean) => void;
}) {
  const { translate } = useSessionMessages();
  const isDraft = uiState.kind === 'draft';
  const mergeDisabled =
    !isMerging && !uiState.canMerge && (!uiState.canBypassRequirements || !bypassRequirements);
  const bypassEnabled = uiState.canBypassRequirements && bypassRequirements;
  const { icon: MergeStatusIcon, iconClass } =
    severityConfig[bypassEnabled ? 'warning' : uiState.severity];
  const mergeStatusTitle = bypassEnabled ? 'Bypass requirements enabled' : uiState.title;

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 py-2.5">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <MergeStatusIcon className={cn('size-4 shrink-0', iconClass)} />
          <p className="truncate text-sm leading-tight text-foreground">{mergeStatusTitle}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {isDraft ? (
            <Button
              variant="outline"
              size="xs"
              onClick={onMarkReady}
              disabled={isMarkingReady}
              aria-label={translate(isMarkingReady ? 'pr.markingReady' : 'pr.markReady')}
            >
              {isMarkingReady && <LoadingIndicator size="inline" />}
              {translate('pr.markReady')}
            </Button>
          ) : (
            <SplitButton
              size="xs"
              variant="outline"
              loading={isMerging}
              loadingLabel="Merging..."
              icon={<GitMerge className="size-3" />}
              actions={mergeActions}
              disabled={mergeDisabled}
            />
          )}
        </div>
      </div>
      {uiState.canBypassRequirements && (
        <label className="flex cursor-pointer items-start gap-2 text-xs leading-snug text-foreground-error">
          <Checkbox
            className="mt-px"
            checked={bypassRequirements}
            onCheckedChange={(checked) => onBypassRequirementsChange(Boolean(checked))}
          />
          <span>{translate('pr.bypassRules')}</span>
        </label>
      )}
    </div>
  );
}
