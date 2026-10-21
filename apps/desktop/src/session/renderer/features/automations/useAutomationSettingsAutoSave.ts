import { useEffect, useRef, useState } from 'react';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';
import type { AgentConfig, TriggerConfig } from '@shared/core/automations/config';
import { assertValidCronTrigger } from '@shared/core/automations/validation';
import type { InitialSessionState } from '../sessions/session-config/initial-session-section';
import { sessionConfigToSave, triggerConfigToSave } from './automation-session-config';
import { formatAutomationError } from './automation-run-format';
import { useAutomations } from './use-automations';
import { useAutomationFormState } from './useAutomationFormState';

export type AutomationSettingsAutoSave = ReturnType<typeof useAutomationSettingsAutoSave>;

export function useAutomationSettingsAutoSave(automation: Automation) {
  const baseFormState = useAutomationFormState(automation);
  const { updateSettings, rename } = useAutomations();
  const { translate } = useSessionMessages();

  const {
    effectiveProjectId,
    prompt,
    provider,
    triggerConfig,
    cronTz,
    canSave,
    buildSessionConfig,
    name,
    workspaceConfig,
  } = baseFormState;

  const [selectionTouched, setSelectionTouched] = useState(false);
  // 服务端此刻认的时间:挂上时是存着的那份,之后是这一页最后一次真送出去的那份。
  // ❌ 拿 `automation` prop 比:保存不等回执就发,prop 要等重新拉取才跟上 —— 改成 B、没等回来又改回 A,
  //    拿旧 prop(A)一比就会漏发,服务端留着 B、屏幕上是 A。与表单自己的 cron 状态同一个口径(挂上时播种一次)。
  const sentTrigger = useRef(automation.triggerConfig);
  // composer 的这几个 setter 只有用户点选时才会被调(播种走的是表单 hook 自己手上那一份),
  // 所以经过这里就是「用户动过」。
  const composer = baseFormState.initialSession;
  const touched = <A extends unknown[]>(set: (...args: A) => void) => (...args: A) => {
    setSelectionTouched(true);
    set(...args);
  };
  const initialSession: InitialSessionState = {
    ...composer,
    setProvider: touched(composer.setProvider),
    setModel: touched(composer.setModel),
    setPlatformModel: touched(composer.setPlatformModel),
    setEffort: touched(composer.setEffort),
    setSessionView: touched(composer.setSessionView),
  };
  const formState = { ...baseFormState, initialSession };

  function buildAgentConfig(): AgentConfig | null {
    const fromComposer = baseFormState.buildAgentConfig();
    if (!fromComposer) return null;
    return sessionConfigToSave(fromComposer, automation.agentConfig, selectionTouched);
  }

  function savePatch(overrideTrigger?: TriggerConfig) {
    if (!effectiveProjectId || !provider) return;
    const activeTrigger = overrideTrigger ?? triggerConfig;
    const sessionConfig = buildSessionConfig(effectiveProjectId);
    if (!sessionConfig) return;
    try {
      assertValidCronTrigger(activeTrigger);
    } catch {
      return;
    }
    if (!name.trim() || !prompt.trim()) return;
    const agentConfig = buildAgentConfig();
    if (!agentConfig) return;
    const triggerPatch = triggerConfigToSave(activeTrigger, sentTrigger.current);
    const previouslySent = sentTrigger.current;
    if (triggerPatch.triggerConfig) sentTrigger.current = triggerPatch.triggerConfig;
    void updateSettings
      .mutateAsync({
        id: automation.id,
        patch: {
          ...triggerPatch,
          agentConfig,
          sessionConfig,
          projectId: effectiveProjectId,
        },
      })
      .catch(() => {
        // 没存上:服务端还是之前那份,下一次保存得把这个时间重新带上。失败原因照旧由 saveError 上屏。
        if (triggerPatch.triggerConfig && sentTrigger.current === triggerPatch.triggerConfig) {
          sentTrigger.current = previouslySent;
        }
      });
  }

  function setCronExpr(expr: string) {
    baseFormState.setCronExpr(expr);
    savePatch({ expr, tz: cronTz });
  }

  // 「谁来跑 / 用哪个模型 / 推理档 / 展示」都在 composer 里,点选就存 —— 从前只盯 provider,
  // 在编辑页换模型、换推理档、切展示都不会落盘,直到下一次碰巧改了 cron 或让提示词失焦。
  // 盯的是**落定之后**的值:换了 agent 之后它的目录异步到齐、默认模型落定,那一刻再存一次,
  // 存下的才是界面上最终显示的那一个。没碰过的时候不存(见 sessionConfigToSave)。
  const selectionKey = JSON.stringify([
    provider,
    composer.model,
    composer.platformModel,
    composer.effort,
    composer.sessionView,
  ]);
  const isFirstSelectionRender = useRef(true);
  useEffect(() => {
    if (isFirstSelectionRender.current) {
      isFirstSelectionRender.current = false;
      return;
    }
    // 只认用户动过之后的变化:目录到齐、agent 名单到齐这类异步落定不是用户的决定,❌ 借它改写记录
    // (这条自动化存的那一家在这台机器上不在时,composer 会落到别家 —— 那一下不能自己存进去)。
    if (selectionTouched && canSave) savePatch();
    // We intentionally only track the selection here; other fields use action-at-change-site.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [selectionKey]);

  // Workspace config changes (preset, branch name, sandbox toggle, etc.) are not
  // interceptable at the setter level because they go through useWorkspaceConfig
  // internals. Serialize the resolved config to a stable primitive key and auto-save
  // whenever it changes, mirroring the selection effect above.
  const resolvedConfigKey = JSON.stringify(workspaceConfig.resolvedConfig);
  const isFirstWorkspaceRender = useRef(true);
  useEffect(() => {
    if (isFirstWorkspaceRender.current) {
      isFirstWorkspaceRender.current = false;
      return;
    }
    if (canSave) savePatch();
    // oxlint-disable-next-line react/exhaustive-deps
  }, [resolvedConfigKey]);

  function handlePromptBlur() {
    if (canSave) savePatch();
  }

  function handleNameBlur() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === automation.name) return;
    void rename.mutateAsync({ id: automation.id, name: trimmed });
  }

  const saveError = updateSettings.error
    ? formatAutomationError(translate, updateSettings.error)
    : rename.error
      ? formatAutomationError(translate, rename.error)
      : null;

  return {
    formState,
    setCronExpr,
    handlePromptBlur,
    handleNameBlur,
    isSaving: updateSettings.isPending || rename.isPending,
    saveError,
  };
}
