import { ProjectSelector } from '@renderer/features/sessions/create-session-modal/project-selector';
import { SessionField } from '@renderer/features/sessions/session-config/session-field';
import { SessionConfigProvider } from '@renderer/features/sessions/session-config/session-config-context';
import { SessionConfigPanel } from '@renderer/features/sessions/session-config/session-config-panel';
import { SessionStateProvider } from '@renderer/features/sessions/session-config/session-state-context';
import { CronPicker } from '@renderer/lib/CronPicker';
import { Field, FieldDescription, FieldError, FieldGroup } from '@renderer/lib/ui/field';
import { Label } from '@renderer/lib/ui/label';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { AutomationFormState } from '../useAutomationFormState';
import { useAutomationsHost } from '../automations-host';

interface AutomationSettingsFieldsProps {
  state: AutomationFormState;
  cronError: string | null;
  onCronExprChange: (expr: string) => void;
  onCronErrorClear: () => void;
  onPromptBlur?: () => void;
  error?: string | null;
}

export function AutomationSettingsFields({
  state,
  cronError,
  onCronExprChange,
  onCronErrorClear,
  onPromptBlur,
  error,
}: AutomationSettingsFieldsProps) {
  const { translate } = useSessionMessages();
  const { remote } = useAutomationsHost();
  const {
    initialSession,
    cronExpr,
    workspaceConfig,
    effectiveProjectId,
    isUnborn,
    setProjectId,
  } = state;

  return (
    <>
      <FieldGroup>
        <Field>
          <Label>{translate('automations.projectLabel')}</Label>
          {/* #6264 已安排看的是哪台机器,就只列那台机器上的项目(同一张项目表)。 */}
          <ProjectSelector
            machine={remote?.deviceId ?? null}
            value={effectiveProjectId}
            onChange={(nextProjectId) => setProjectId(nextProjectId)}
          />
        </Field>
        <Field>
          <Label>{translate('automations.scheduleLabel')}</Label>
          <CronPicker
            value={cronExpr}
            onChange={(nextCronExpr) => {
              onCronExprChange(nextCronExpr);
              onCronErrorClear();
            }}
          />
          {cronError && <FieldError>{cronError}</FieldError>}
        </Field>
        <SessionStateProvider
          workspaceConfig={workspaceConfig}
          initialSession={initialSession}
          projectId={effectiveProjectId}
          isUnborn={isUnborn}
          hasPR={false}
          includeIssueContextByDefault={false}
        >
          <SessionConfigProvider showPrPresets={false} autoBranchName={true}>
            <SessionConfigPanel
              tabs={[
                {
                  value: 'prompt',
                  label: translate('automations.promptTab'),
                  content: (
                    <>
                      <SessionField
                        onPromptBlur={onPromptBlur}
                        textareaClassName="min-h-40"
                        placeholder={translate('automations.promptPlaceholder')}
                        enableMentions={false}
                        showAutoApproveToggle={false}
                        enableAttachments={false}
                      />
                      {initialSession.provider && (
                        <FieldDescription
                          className={
                            initialSession.autoApprove
                              ? undefined
                              : 'text-foreground-destructive'
                          }
                        >
                          {translate(
                            initialSession.autoApprove
                              ? 'automations.unattendedAccess'
                              : 'automations.unattendedAccessUnsupported'
                          )}
                        </FieldDescription>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </SessionConfigProvider>
        </SessionStateProvider>
      </FieldGroup>

      {error && <p className="text-foreground-destructive text-xs">{error}</p>}
    </>
  );
}
