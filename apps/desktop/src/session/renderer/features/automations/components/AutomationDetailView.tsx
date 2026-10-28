import { AutomationAgentAvatar } from './AutomationAgentAvatar';
import { Ellipsis, Play, Trash2 } from '@/lib/icons';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { EditableNameField } from '@renderer/lib/ui/editable-name-field';
import { PanelTabs } from '@renderer/lib/ui/panel-tabs';
import { Switch } from '@renderer/lib/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { isSpentOneTimeAutomation, type Automation } from '@shared/core/automations/automation';
import { useAutomationEventBridge, useAutomations } from '../use-automations';
import { useAutomationSettingsAutoSave } from '../useAutomationSettingsAutoSave';
import { AutomationSettingsFields } from './AutomationSettingsFields';
import { NextRunBanner } from './NextRunBanner';
import { RunHistory } from './RunHistory';
import { SheetHeader } from './sheet-header';

type AutomationTab = 'runs' | 'settings';

export interface AutomationDetailViewProps {
  automation: Automation;
  onClose: () => void;
  onDelete?: (automation: Automation) => void;
  onRunNow?: (automation: Automation) => void;
  onToggleEnabled?: (automation: Automation, enabled: boolean) => void;
  runNowPending?: boolean;
  /** 那台机器此刻做不了事(离线 / server 太旧,#6264):照旧能看,立即运行、开关、删除、改设置一起灰。 */
  readOnly?: boolean;
}

export const AutomationDetailView = observer(function AutomationDetailView(
  props: AutomationDetailViewProps
) {
  // #7221 agent 给自己排的那条:内容只由它自己的工具建、取消 —— 这里看得见、能停、能删、能改名,❌ 设置页
  // (那一页的自动保存会拿新建会话的那套配置去改写它)。
  return props.automation.agentSessionId ? (
    <AgentScheduleDetailView {...props} />
  ) : (
    <AutomationSettingsDetailView {...props} />
  );
});

const AutomationSettingsDetailView = observer(function AutomationSettingsDetailView({
  automation,
  onClose,
  onDelete,
  onToggleEnabled,
  runNowPending: _runNowPending,
  readOnly = false,
}: AutomationDetailViewProps) {
  const [activeTab, setActiveTab] = useState<AutomationTab>('runs');
  const [cronError, setCronError] = useState<string | null>(null);
  const { translate } = useSessionMessages();
  const automationTabs: { value: AutomationTab; label: string }[] = [
    { value: 'runs', label: translate('automations.tabRuns') },
    { value: 'settings', label: translate('automations.tabSettings') },
  ];

  useAutomationEventBridge(automation.id);

  const { formState, setCronExpr, handlePromptBlur, handleNameBlur, saveError } =
    useAutomationSettingsAutoSave(automation);
  const { name, setName } = formState;

  const { runNow } = useAutomations();

  const canRunNow = !!automation.projectId && !runNow.isPending && !readOnly;

  return (
    <div className="flex h-full flex-col">
      <SheetHeader title={translate('automations.detailsLabel')} onClose={onClose} />
      <div className="flex flex-col gap-2 px-4">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex flex-1 flex-row items-center gap-3">
            <EditableNameField
              autoFocus={false}
              value={name}
              onChange={setName}
              onBlur={handleNameBlur}
              placeholder={translate('automations.namePlaceholder')}
              className="flex-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              {/* data-testid 而不是靠图标 class 选:图标库换到 Solar 后 svg 不再带
                  `lucide-*` class,`button:has(svg.lucide-ellipsis)` 会静默选不中。 */}
              <DropdownMenuTrigger
                disabled={readOnly}
                render={<Button variant="ghost" size="sm" />}
              >
                <Ellipsis className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={readOnly}
                  onClick={() => onDelete?.(automation)}
                >
                  <Trash2 />
                  {translate('automations.deleteTitle')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Switch
              checked={automation.enabled}
              disabled={readOnly}
              onCheckedChange={(checked) => onToggleEnabled?.(automation, checked)}
              aria-label={
                automation.enabled
                  ? translate('automations.pause')
                  : translate('automations.enable')
              }
            />
          </div>
        </div>
        <NextRunBanner automationId={automation.id} />
        <div className="flex items-center gap-2 py-2">
          <PanelTabs compact value={activeTab} onChange={setActiveTab} tabs={automationTabs} />
          {activeTab === 'runs' && (
            <div className="ml-auto flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-md"
                      disabled={!canRunNow}
                      onClick={() => void runNow.mutateAsync(automation.id)}
                    />
                  }
                >
                  <Play className="size-3.5" />
                </TooltipTrigger>
                <TooltipContent>
                  {automation.projectId == null
                    ? translate('automations.assignProjectFirst')
                    : !automation.agentConfig || !automation.triggerConfig
                      ? translate('automations.configureFirst')
                      : translate('automations.runNow')}
                </TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {activeTab === 'runs' && <RunHistory automation={automation} />}
        {activeTab === 'settings' && (
          // 看得到、改不了:fieldset 的 disabled 传给表单里每个控件(tab 切换、运行记录照常能看)。
          <fieldset
            disabled={readOnly}
            className="contents"
            data-testid="automation-detail-settings"
          >
            <AutomationSettingsFields
              state={formState}
              cronError={cronError}
              onCronExprChange={(expr) => {
                setCronExpr(expr);
                setCronError(null);
              }}
              onCronErrorClear={() => setCronError(null)}
              onPromptBlur={handlePromptBlur}
              error={saveError}
            />
          </fieldset>
        )}
      </div>
    </div>
  );
});

const AgentScheduleDetailView = observer(function AgentScheduleDetailView({
  automation,
  onClose,
  onDelete,
  onToggleEnabled,
  readOnly = false,
}: AutomationDetailViewProps) {
  const { translate } = useSessionMessages();
  const [name, setName] = useState(automation.name);
  const { rename, runNow } = useAutomations();
  useAutomationEventBridge(automation.id);

  const agent = automation.agentSession;
  const gone = agent?.gone ?? true;
  const canRunNow = !gone && !runNow.isPending && !readOnly;

  function handleNameBlur() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === automation.name) return;
    void rename.mutateAsync({ id: automation.id, name: trimmed });
  }

  return (
    <div className="flex h-full flex-col">
      <SheetHeader title={translate('automations.detailsLabel')} onClose={onClose} />
      <div className="flex flex-col gap-2 px-4">
        <div className="flex w-full items-center justify-between gap-2">
          <div className="flex flex-1 flex-row items-center gap-3">
            <EditableNameField
              autoFocus={false}
              value={name}
              onChange={setName}
              onBlur={handleNameBlur}
              placeholder={translate('automations.namePlaceholder')}
              className="flex-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger disabled={readOnly} render={<Button variant="ghost" size="sm" />}>
                <Ellipsis className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  variant="destructive"
                  disabled={readOnly}
                  onClick={() => onDelete?.(automation)}
                >
                  <Trash2 />
                  {translate('automations.deleteTitle')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Switch
              checked={automation.enabled}
              disabled={readOnly || isSpentOneTimeAutomation(automation)}
              onCheckedChange={(checked) => onToggleEnabled?.(automation, checked)}
              aria-label={
                automation.enabled ? translate('automations.pause') : translate('automations.enable')
              }
            />
          </div>
        </div>
        <NextRunBanner automationId={automation.id} />
        <div className="flex flex-col gap-2 rounded-lg bg-background-1 p-2 text-sm">
          <span className="flex items-start gap-2 text-foreground-muted">
            <AutomationAgentAvatar sessionId={automation.agentSessionId} />
            {gone
              ? translate('automations.agentScheduleNoteGone')
              : translate('automations.agentScheduleNote', { name: agent?.name ?? '' })}
          </span>
          <span className="text-xs text-foreground-passive">
            {translate('automations.agentScheduleText')}
          </span>
          <p className="whitespace-pre-wrap break-words text-foreground">
            {automation.agentConfig?.prompt ?? ''}
          </p>
        </div>
        <div className="flex items-center gap-2 py-2">
          <span className="text-sm text-foreground-muted">{translate('automations.tabRuns')}</span>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-md"
                    disabled={!canRunNow}
                    onClick={() => void runNow.mutateAsync(automation.id)}
                  />
                }
              >
                <Play className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>
                {gone ? translate('automations.byAgentGone') : translate('automations.runNow')}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <RunHistory automation={automation} />
      </div>
    </div>
  );
});
