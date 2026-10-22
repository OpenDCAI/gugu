import cronstrue from 'cronstrue';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Clock, X } from '@/lib/icons';
import { setComposerVerb, takeComposerCarry } from '@/lib/composerVerbBridge';
import { platform } from '@/platform';
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels';
import { ProjectSelector } from '@renderer/features/sessions/create-session-modal/project-selector';
import { SessionField } from '@renderer/features/sessions/session-config/session-field';
import { SessionStateProvider } from '@renderer/features/sessions/session-config/session-state-context';
import { CronPicker } from '@renderer/lib/CronPicker';
import { sessionpageMessageHost } from '@renderer/lib/sessionpage-message-host';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { assertValidCronTrigger } from '@shared/core/automations/validation';
import { formatAutomationError } from '../automations/automation-run-format';
import { useAutomations } from '../automations/use-automations';
import { useAutomationFormState } from '../automations/useAutomationFormState';
import { sessionComposerFrameLiftClassName, sessionComposerTrayClassName, sessionComposerTrayStyle, sessionComposerTrayTriggerClassName } from './session-composer-styles';

/** 已安排卡上那一句时间:与「已安排」列表里的那一行同一个读法。 */
function scheduleLabelOf(expr: string): string {
  try {
    return cronstrue.toString(expr.trim());
  } catch {
    return expr;
  }
}

/**
 * gugu-dev#181「定时任务」:对话的输入框选了「定时任务」时换上来的框。建的是一条现成的已安排(createAutomation),
 * 与「已安排」页同一份表单状态;建好后这个对话里落一张「已安排 · 时间」的卡(我发的、不叫醒谁)。到点每次开跑
 * 都是一条新会话,❌ 每次再出一张卡。
 */
export const ScheduleDispatchComposer = observer(function ScheduleDispatchComposer({
  chatId,
  projectId: fixedProjectId,
}: {
  chatId: string;
  /** 项目块:建在这个项目里,项目不可选。 */
  projectId?: string;
}) {
  const { translate } = useSessionMessages();
  const form = useAutomationFormState();
  // 选词那一刻框里写着的话跟过来(与新任务那个框同一份 carry)。
  useState(() => {
    const carried = takeComposerCarry(chatId);
    if (carried) form.initialSession.setPrompt(carried);
    return null;
  });
  const [projectSeeded, setProjectSeeded] = useState(false);
  if (fixedProjectId && !projectSeeded) {
    setProjectSeeded(true);
    form.setProjectId(fixedProjectId);
  }
  const { create } = useAutomations();
  const [error, setError] = useState<string | null>(null);
  const close = () => setComposerVerb(chatId, null);
  const canSubmit =
    form.prompt.trim().length > 0 && !!form.provider && form.autoApprove && !!form.effectiveProjectId && form.workspaceConfig.isValid && !create.isPending;

  const save = async () => {
    const projectId = form.effectiveProjectId;
    if (!canSubmit || !projectId) return;
    setError(null);
    const text = form.prompt.trim();
    try {
      assertValidCronTrigger(form.triggerConfig);
      const sessionConfig = form.buildSessionConfig(projectId);
      const agentConfig = form.buildAgentConfig();
      if (!sessionConfig || !agentConfig) return;
      const saved = await create.mutateAsync({
        name: [...(text.split('\n')[0] ?? text)].slice(0, 40).join(''),
        triggerConfig: form.triggerConfig,
        agentConfig,
        sessionConfig,
        projectId,
      });
      const self = await platform.getLocalDeviceSelfSnapshot?.();
      if (!self?.device_id) throw new Error('this computer is not registered as a Gugu device yet');
      const content = serializeComposerCard({
        v: 1,
        type: 'schedule',
        text,
        automationId: saved.id,
        scheduleLabel: scheduleLabelOf(form.triggerConfig.expr),
        deviceId: self.device_id,
        machineLabel: self.label,
      });
      await sessionpageMessageHost().sendCardToChat(chatId, content);
      form.initialSession.setPrompt('');
      close();
    } catch (saveError) {
      setError(formatAutomationError(translate, saveError));
    }
  };

  return (
    <div data-testid="schedule-dispatch-composer" data-chat-id={chatId}>
      <div className={sessionComposerTrayClassName} style={sessionComposerTrayStyle}>
        <span className={sessionComposerTrayTriggerClassName} data-testid="schedule-dispatch-verb">
          <Clock className="size-3 shrink-0" />
          <span>{translate('taskDispatch.schedule')}</span>
          <button
            type="button"
            aria-label={translate('taskDispatch.cancel')}
            title={translate('taskDispatch.cancel')}
            onClick={close}
            className="-mr-1 grid size-4 place-items-center rounded-sm hover:bg-row-hover"
            data-testid="schedule-dispatch-cancel"
          >
            <X className="size-3" />
          </button>
        </span>
        {fixedProjectId ? null : (
          <ProjectSelector machine={null} value={form.effectiveProjectId} onChange={(projectId) => form.setProjectId(projectId)} />
        )}
        <CronPicker value={form.cronExpr} onChange={(expr) => { form.setCronExpr(expr); setError(null); }} />
      </div>
      <div className={sessionComposerFrameLiftClassName}>
        <SessionStateProvider
          workspaceConfig={form.workspaceConfig}
          initialSession={form.initialSession}
          projectId={form.effectiveProjectId}
          isUnborn={form.isUnborn}
          hasPR={false}
          includeIssueContextByDefault={false}
        >
          <SessionField
            placeholder={translate('taskDispatch.schedulePlaceholder')}
            enableMentions={false}
            showAutoApproveToggle={false}
            enableAttachments={false}
            onSubmit={() => { void save(); }}
            canSubmit={canSubmit}
          />
        </SessionStateProvider>
      </div>
      {error ? <p role="alert" className="px-1 pt-1 text-xs text-foreground-destructive">{error}</p> : null}
    </div>
  );
});
