import { CheckCircle2, ChevronDown } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { useLocalStorage } from '@renderer/lib/hooks/useLocalStorage';
import { Button } from '@renderer/lib/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@renderer/lib/ui/collapsible';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import { EditableNameField } from '@renderer/lib/ui/editable-name-field';
import { Field } from '@renderer/lib/ui/field';
import { Label } from '@renderer/lib/ui/label';
import { SheetFooter } from '@renderer/lib/ui/sheet';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';
import { assertValidCronTrigger } from '@shared/core/automations/validation';
import { formatAutomationError } from '../automation-run-format';
import type { BuiltinAutomationTemplate } from '../automation-template';
import { buildBuiltinAutomationCatalog } from '../builtin-catalog';
import { useAutomations } from '../use-automations';
import { useAutomationFormState } from '../useAutomationFormState';
import { AutomationSettingsFields } from './AutomationSettingsFields';
import { AutomationTemplateRail } from './AutomationTemplateRail';
import { SheetHeader } from './sheet-header';

const TEMPLATE_SECTION_COLLAPSED_KEY = 'gugu-automation-template-section-collapsed';

export interface CreateAutomationViewProps {
  onClose: () => void;
  onSaved?: (automation: Automation) => void;
  initialTemplate?: BuiltinAutomationTemplate;
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):表单照旧看得到,创建与各项一起灰。 */
  readOnly?: boolean;
}

export const CreateAutomationView = observer(function CreateAutomationView({
  onClose,
  onSaved,
  initialTemplate,
  readOnly = false,
}: CreateAutomationViewProps) {
  const formState = useAutomationFormState(undefined, initialTemplate);
  const {
    name,
    setName,
    effectiveProjectId,
    provider,
    canSave,
    triggerConfig,
    applyTemplate,
    buildSessionConfig,
    buildAgentConfig,
  } = formState;

  const [error, setError] = useState<string | null>(null);
  const [cronError, setCronError] = useState<string | null>(null);
  const [templatesCollapsed, setTemplatesCollapsed] = useLocalStorage(
    TEMPLATE_SECTION_COLLAPSED_KEY,
    false
  );

  const { create } = useAutomations();
  const { toast } = useToast();
  const { translate } = useSessionMessages();
  const templates = useMemo(() => buildBuiltinAutomationCatalog(translate), [translate]);
  const isPending = create.isPending;

  async function handleSave() {
    if (readOnly || !effectiveProjectId || !provider || !canSave) return;
    setError(null);
    const sessionConfig = buildSessionConfig(effectiveProjectId);
    if (!sessionConfig) return;
    try {
      assertValidCronTrigger(triggerConfig);
    } catch (validationError) {
      setCronError(formatAutomationError(translate, validationError));
      return;
    }
    setCronError(null);
    const agentConfig = buildAgentConfig();
    if (!agentConfig) return;
    try {
      const trimmedName = name.trim();
      const saved = await create.mutateAsync({
        name: trimmedName,
        triggerConfig,
        agentConfig,
        sessionConfig,
        projectId: effectiveProjectId,
      });
      toast({
        title: translate('automations.createdToast'),
        description: translate('automations.createdToastDescription', { name: saved.name }),
        icon: <CheckCircle2 className="size-4 text-foreground-success" aria-hidden="true" />,
      });
      onSaved?.(saved);
    } catch (saveError) {
      setError(formatAutomationError(translate, saveError));
    }
  }

  function handleTemplateSelect(template: BuiltinAutomationTemplate) {
    applyTemplate(template);
    setError(null);
    setCronError(null);
  }

  return (
    <div className="flex h-full flex-col">
      <SheetHeader title={translate('automations.createTitle')} onClose={onClose} />
      <fieldset disabled={readOnly} className="contents" data-testid="automation-create-fields">
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 px-4">
            <Field>
              <Label>{translate('automations.nameLabel')}</Label>
              <EditableNameField
                autoFocus={name.trim().length === 0}
                value={name}
                onChange={setName}
                placeholder={translate('automations.createNamePlaceholder')}
                className="h-9 text-sm"
              />
            </Field>
            <AutomationSettingsFields
              state={formState}
              cronError={cronError}
              onCronExprChange={(expr) => formState.setCronExpr(expr)}
              onCronErrorClear={() => setCronError(null)}
              error={error}
            />
          </div>
        </div>
        <Collapsible
          open={!templatesCollapsed}
          onOpenChange={(open) => setTemplatesCollapsed(!open)}
          className="group border-t border-border bg-background"
        >
          <div className="flex w-full items-center justify-between gap-3 p-4 py-3">
            <Label>{translate('automations.useATemplate')}</Label>

            <CollapsibleTrigger
              render={
                <Button variant="ghost" size="icon-xs">
                  <ChevronDown className="size-3.5 shrink-0 text-foreground-passive transition-transform duration-[var(--dur-fast,120ms)] group-data-open:rotate-180" />
                </Button>
              }
            ></CollapsibleTrigger>
          </div>
          <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-[var(--dur-slow,260ms)] ease-out">
            <AutomationTemplateRail templates={templates} onSelect={handleTemplateSelect} compact />
          </CollapsibleContent>
        </Collapsible>
      </fieldset>
      <SheetFooter className="flex flex-row items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          {translate('automations.cancel')}
        </Button>
        <ConfirmButton
          size="sm"
          onClick={() => {
            void handleSave();
          }}
          disabled={!canSave || isPending || readOnly}
        >
          {isPending ? translate('automations.saving') : translate('automations.create')}
        </ConfirmButton>
      </SheetFooter>
    </div>
  );
});
