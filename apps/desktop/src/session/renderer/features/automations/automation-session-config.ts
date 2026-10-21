import type { AgentConfig, TriggerConfig } from '@shared/core/automations/config';
import { sessionRuntimeOfView, type SessionView } from '@shared/core/sessions/sessions';

/** composer 上决定「这条会话怎么开」的那几格(`InitialSessionState` 的子集)。 */
export type AutomationComposerSelection = {
  provider: string | null;
  prompt: string;
  autoApprove: boolean;
  /** harness 自家模型;选了平台模型时为 null。 */
  model: string | null;
  effort: string | null;
  /** 选中的咕咕平台模型 id;null = harness 自家模型。 */
  platformModel: string | null;
  sessionView: SessionView;
};

/**
 * composer 上这一刻的选择 → 这条自动化要存的那份 AgentConfig。新建与编辑(自动保存)共用这一份,
 * 维度与新建会话文档(`buildInitialSessionDocument`)一一对应:agent、展示、模型(harness 自家或
 * 咕咕平台,三态)、推理档、第一句话。❌ 别在两个调用点各拼一份 —— 原来就是这么漏掉平台模型的。
 *
 * 权限只存「无人值守」那一个布尔(主进程只收这一档),档位到点时由它派生。
 */
export function automationSessionConfig(
  state: AutomationComposerSelection
): AgentConfig | null {
  if (!state.provider) return null;
  return {
    prompt: state.prompt.trim(),
    provider: state.provider,
    autoApprove: state.autoApprove,
    // 选了平台模型时 harness 那一格为 null(模型由网关 token 钉死),两者不会同时说话。
    model: state.model ?? undefined,
    effort: state.effort ?? undefined,
    // 编辑器就是这条自动化的平台决策点:选 harness 也显式写 null。
    platformModel: state.platformModel ? { modelId: state.platformModel } : null,
    type: sessionRuntimeOfView(state.sessionView),
  };
}

/**
 * 编辑页自动保存时要存的那份。
 *
 * 用户在这一页上还没碰过「谁来跑 / 用哪个模型 / 推理档 / 展示」时,这几格写回的是这条记录**存着的**那一套,
 * ❌ 不是 composer 这一帧显示的:composer 的选择要等 agent 名单、模型目录异步到齐才落定,途中那几帧
 * (目录还没到 ⇒ 模型为空、平台模型还没解析出来)被任何一次保存(改 cron、提示词失焦)顺手写回去,
 * 就会悄悄抹掉用户没碰过的模型 —— updateSettings 是整份替换,不是合并。
 * 会话名(`title`)不在 composer 上,一律照存的原样带过去。
 */
export function sessionConfigToSave(
  composer: AgentConfig,
  stored: AgentConfig | undefined,
  selectionTouched: boolean
): AgentConfig {
  const title = stored?.title !== undefined ? { title: stored.title } : {};
  if (selectionTouched || !stored || stored.provider !== composer.provider) {
    return { ...composer, ...title };
  }
  return {
    prompt: composer.prompt,
    provider: composer.provider,
    autoApprove: composer.autoApprove,
    ...title,
    ...(stored.model !== undefined ? { model: stored.model } : {}),
    ...(stored.effort !== undefined ? { effort: stored.effort } : {}),
    // 三态照存的原样:旧记录没有这一格就继续没有(到点回落 agent 级),❌ 补成 null。
    ...(stored.platformModel !== undefined ? { platformModel: stored.platformModel } : {}),
    ...(stored.type !== undefined ? { type: stored.type } : {}),
  };
}

/**
 * 自动保存要不要带 `triggerConfig`。
 *
 * 服务端把「patch 里有 triggerConfig」读成「时间变了」(automations-service 的 updateAutomationSettings),
 * 当场把已经排好的下一次作废重排 —— 运行记录里多一条「Skipped · trigger_changed」。编辑页原来每一次保存
 * 都整份带上它,于是改一下提示词、换一个模型,运行记录里就多出几条谁也没跳过的「跳过」。
 * ⇒ 只在时间真的变了时才带。
 */
export function triggerConfigToSave(
  active: TriggerConfig,
  stored: TriggerConfig | undefined
): { triggerConfig?: TriggerConfig } {
  const same = !!stored && stored.expr === active.expr && (stored.tz ?? null) === (active.tz ?? null);
  return same ? {} : { triggerConfig: active };
}
