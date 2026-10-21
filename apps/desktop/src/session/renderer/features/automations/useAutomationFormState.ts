import type { AgentProviderId } from '@gugu/session-plugins/agents';
import { useState } from 'react';
import { DEFAULT_CRON_STATE, toCron } from '@renderer/lib/CronPicker/cron-utils';
import { useAgents } from '@renderer/lib/stores/use-agents';
import type { Automation } from '@shared/core/automations/automation';
import { sessionViewOfRuntime } from '@shared/core/sessions/sessions';
import type {
  AgentConfig,
  StoredAutomationSessionConfig,
  TriggerConfig,
} from '@shared/core/automations/config';
import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import { getLocalTimeZone } from '@shared/core/automations/timezone';
import {
  asMounted,
  firstMountedProjectId,
  getProjectStore,
} from '../projects/stores/project-selectors';
import { useProjectGitContext } from '../sessions/create-session-modal/use-project-git-context';
import { useSessionName } from '../sessions/create-session-modal/use-session-name';
import { useWorkspaceConfig } from '../sessions/create-session-modal/use-workspace-config';
import { useInitialSessionState } from '../sessions/session-config/initial-session-section';
import { automationSessionConfig } from './automation-session-config';
import type { BuiltinAutomationTemplate } from './automation-template';
import { useAutomationsHost } from './automations-host';

const DEFAULT_CRON = toCron(DEFAULT_CRON_STATE);

export type AutomationFormState = ReturnType<typeof useAutomationFormState>;

export function useAutomationFormState(
  seed?: Automation,
  initialTemplate?: BuiltinAutomationTemplate
) {
  const seedTrigger = seed?.triggerConfig;
  const seedSessionConfig = seed?.agentConfig;
  const seedConfig = seed?.sessionConfig;
  const seedPrompt =
    seedSessionConfig?.prompt ?? initialTemplate?.defaultSessionConfig.initialPrompt;
  const { data: agents } = useAgents();
  // #6264 已安排看的是哪台机器,项目就只在那台机器的项目里挑(同一张项目表,见 firstMountedProjectId)。
  const machine = useAutomationsHost().remote?.deviceId ?? null;

  const [name, setName] = useState(seed?.name ?? initialTemplate?.name ?? '');
  const [projectId, setProjectId] = useState<string | undefined>(
    seed?.projectId ?? firstMountedProjectId(machine)
  );
  const [cronExpr, setCronExpr] = useState<string>(
    seedTrigger?.expr ?? initialTemplate?.defaultTrigger.expr ?? DEFAULT_CRON
  );
  const [cronTz] = useState<string>(seedTrigger?.tz ?? getLocalTimeZone());

  const effectiveProjectId =
    projectId && asMounted(getProjectStore(projectId)) ? projectId : firstMountedProjectId(machine);

  const seedProvider = agents?.some((agent) => agent.id === seedSessionConfig?.provider)
    ? (seedSessionConfig?.provider as AgentProviderId)
    : undefined;

  const seedModel = seedSessionConfig?.model ?? undefined;
  const seedEffort = seedSessionConfig?.effort ?? undefined;
  // 三态:undefined = 这一维出现之前存下的旧记录(没决策过,❌ 播种成 null —— 那是「明确要 harness」)。
  const seedPlatformModel = seedSessionConfig?.platformModel;

  // 与新建页同一个 composer:咕咕那一组照样列出、照样预选,选的是什么就存什么(随 AgentConfig
  // 的 `platformModel`),到点交给同一个翻译点。
  const initialSession = useInitialSessionState(effectiveProjectId, seedProvider, true, {
    resetPromptOnProjectChange: false,
    // 到点自己跑,没人守着答权限弹窗:默认无人值守那一档,❌ 继承会话页记住的档(那会让表单存不了)。
    unattended: true,
  });

  const [promptSeeded, setPromptSeeded] = useState(false);
  if (!promptSeeded && seedPrompt) {
    setPromptSeeded(true);
    initialSession.setPrompt(seedPrompt);
  }

  // 模型的选择按 agent 记:composer 落到这条记录的 agent 上之前播进去,会记在别家名下然后丢掉
  // (agent 名单是异步到的,到之前 composer 手上可能还没有这一家)。
  const seedAgentLanded = !!seedProvider && initialSession.provider === seedProvider;
  const [modelSeeded, setModelSeeded] = useState(false);
  if (!modelSeeded && seedAgentLanded && (seedModel || seedPlatformModel !== undefined)) {
    setModelSeeded(true);
    // 两者互斥(选平台模型时 harness 那一格不存);setModel 本身就是「不上平台」的表态。
    if (seedPlatformModel) initialSession.setPlatformModel(seedPlatformModel.modelId);
    else if (seedModel) initialSession.setModel(seedModel);
    else initialSession.setPlatformModel(null);
  }

  // 强度必须在模型**落定之后**播种:档位按模型算(effort 的记忆键里就有模型),模型目录又是异步到的 ——
  // 目录还没到时 composer 显示的是别的模型,这时播进去的档会记在别人名下、然后丢掉。
  const [effortSeeded, setEffortSeeded] = useState(false);
  const seededSelectionLanded = seedPlatformModel
    ? initialSession.platformModel === seedPlatformModel.modelId
    : seedModel
      ? initialSession.model === seedModel
      : true;
  if (modelSeeded && !effortSeeded && seedEffort && seededSelectionLanded) {
    setEffortSeeded(true);
    initialSession.setEffort(seedEffort);
  }

  // 编辑一条已存的自动化时,展示按它存的那份来 —— 两种都播种,❌ 只在通用视角时播:那会让存着
  // 编程视角的自动化在偏好为通用的机器上被显示成通用,一保存就悄悄改了它。
  // 存的是运行时词(`type`: pty/acp),这里翻回产品词再交给 composer。
  const seedType = seedSessionConfig?.type;
  const [sessionViewSeeded, setSessionViewSeeded] = useState(false);
  if (!sessionViewSeeded && seedType) {
    setSessionViewSeeded(true);
    initialSession.setSessionView(sessionViewOfRuntime(seedType));
  }

  const localGit = useProjectGitContext(effectiveProjectId);
  const { isUnborn, currentBranch } = localGit;
  const repositoryWorkspaceId = localGit.repositoryWorkspaceId;

  const sessionName = useSessionName({
    generatedName: seedConfig?.sessionConfig.name,
    resetKey: effectiveProjectId,
  });

  const workspaceConfig = useWorkspaceConfig({ repositoryWorkspaceId });

  const prompt = initialSession.prompt;
  const provider = initialSession.provider;
  const model = initialSession.model;
  const effort = initialSession.effort;
  const autoApprove = initialSession.autoApprove;

  const canSave =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !!provider &&
    autoApprove &&
    !!effectiveProjectId &&
    workspaceConfig.isValid;

  function buildSessionConfig(targetProjectId: string): StoredAutomationSessionConfig | null {
    const effectiveRepoWsId = asMounted(getProjectStore(targetProjectId))?.data?.repositoryWorkspaceId ?? null;

    // Re-resolve with the target project's repositoryWorkspaceId in case it differs from
    // the one the form was edited against.
    const wsConfig = workspaceConfig.resolvedConfig;
    if (!wsConfig) return null;

    const patchedConfig: WorkspaceConfig =
      wsConfig.workspace.kind === 'repository-instance' && effectiveRepoWsId
        ? {
            ...wsConfig,
            workspace: { kind: 'repository-instance' as const, workspaceId: effectiveRepoWsId },
          }
        : wsConfig;

    const result: StoredAutomationSessionConfig = {
      version: '1',
      sessionConfig: {
        version: '1',
        name: sessionName.effectiveSessionName?.trim() || name.trim(),
        linkedIssue: seedConfig?.sessionConfig.linkedIssue,
      },
      workspaceConfig: patchedConfig,
    };

    // Strip MobX Proxy wrappers (e.g. fromBranch coming from getGitRepositoryStore)
    // before the value crosses the Electron contextBridge. The structured clone
    // algorithm rejects Proxy objects with a DataCloneError.
    return JSON.parse(JSON.stringify(result)) as StoredAutomationSessionConfig;
  }

  const triggerConfig: TriggerConfig = { expr: cronExpr.trim(), tz: cronTz };

  function buildAgentConfig(): AgentConfig | null {
    return automationSessionConfig(initialSession);
  }

  function applyTemplate(template: BuiltinAutomationTemplate) {
    setName(template.name);
    setCronExpr(template.defaultTrigger.expr);
    initialSession.setPrompt(template.defaultSessionConfig.initialPrompt);
  }

  return {
    name,
    setName,
    projectId,
    setProjectId,
    effectiveProjectId,
    cronExpr,
    setCronExpr,
    cronTz,
    initialSession,
    workspaceConfig,
    isUnborn,
    currentBranch,
    prompt,
    provider,
    model,
    effort,
    autoApprove,
    canSave,
    triggerConfig,
    applyTemplate,
    buildSessionConfig,
    buildAgentConfig,
  };
}
