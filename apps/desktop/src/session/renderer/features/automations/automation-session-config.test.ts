import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '@shared/core/automations/config';
import {
  automationSessionConfig,
  sessionConfigToSave,
  triggerConfigToSave,
  type AutomationComposerSelection,
} from './automation-session-config';

const selection: AutomationComposerSelection = {
  provider: 'claude',
  prompt: '  Check the nightly build  ',
  autoApprove: true,
  model: null,
  effort: 'high',
  platformModel: 'glm-5.2',
  sessionView: 'general',
};

describe('automationConversationConfig', () => {
  // 原来「已安排」的表单不提供咕咕那一组,存的配置里也没有这一格 —— 选了也无处可存。
  it('stores the Gugu model the composer picked', () => {
    expect(automationSessionConfig(selection)).toEqual({
      prompt: 'Check the nightly build',
      provider: 'claude',
      autoApprove: true,
      model: undefined,
      effort: 'high',
      platformModel: { modelId: 'glm-5.2' },
      type: 'acp',
    });
  });

  // 选 harness 也是一次表态:显式 null,到点时 ❌ 被当成「没决策过」回落 agent 级(那可能正是平台)。
  it('writes an explicit null when the harness model is chosen', () => {
    const config = automationSessionConfig({
      ...selection,
      model: 'sonnet',
      platformModel: null,
      sessionView: 'code',
    });
    expect(config).toEqual(
      expect.objectContaining({ model: 'sonnet', platformModel: null, type: 'pty' })
    );
  });

  it('has nothing to store before an agent is chosen', () => {
    expect(automationSessionConfig({ ...selection, provider: null })).toBeNull();
  });
});

describe('sessionConfigToSave', () => {
  const stored: AgentConfig = {
    prompt: 'old prompt',
    provider: 'claude',
    title: 'Nightly',
    autoApprove: true,
    model: 'opus',
    effort: 'max',
    type: 'pty',
  };
  // composer 这一帧:模型目录还没到,模型为空、平台那一格按默认落在了别处。
  const composerMidLoad: AgentConfig = {
    prompt: 'new prompt',
    provider: 'claude',
    autoApprove: true,
    effort: undefined,
    platformModel: { modelId: 'glm-5.2' },
    type: 'acp',
  };

  // 改一下提示词就把没碰过的模型抹掉 —— updateSettings 是整份替换。
  it('keeps the stored selection until the user touches it', () => {
    expect(sessionConfigToSave(composerMidLoad, stored, false)).toEqual({
      prompt: 'new prompt',
      provider: 'claude',
      autoApprove: true,
      title: 'Nightly',
      model: 'opus',
      effort: 'max',
      type: 'pty',
    });
  });

  // 三态:旧记录没有这一格就继续没有 —— 补成 null 会把原来回落 agent 级(可能是平台)的任务改成 BYOK。
  it('does not invent a platform decision for an older record', () => {
    expect(sessionConfigToSave(composerMidLoad, stored, false)).not.toHaveProperty(
      'platformModel'
    );
  });

  // 阳控:同一对输入,用户动过之后存的就是 composer 上的选择(会话名仍照原样)。
  it('saves the composer selection once the user has touched it', () => {
    expect(sessionConfigToSave(composerMidLoad, stored, true)).toEqual({
      ...composerMidLoad,
      title: 'Nightly',
    });
  });

  it('takes the composer selection when the agent itself changed', () => {
    const otherAgent = { ...composerMidLoad, provider: 'codex' };
    expect(sessionConfigToSave(otherAgent, stored, false)).toEqual({
      ...otherAgent,
      title: 'Nightly',
    });
  });
});

describe('triggerConfigToSave', () => {
  const stored = { expr: '0 9 * * *', tz: 'Asia/Shanghai' };

  // 服务端见到 triggerConfig 就作废已排好的下一次:没变的时间 ❌ 带过去。
  it('leaves an unchanged schedule out of the patch', () => {
    expect(triggerConfigToSave({ expr: '0 9 * * *', tz: 'Asia/Shanghai' }, stored)).toEqual({});
  });

  // 阳控:同一把比较,时间或时区真的变了就要带。
  it('sends the schedule when it changed', () => {
    expect(triggerConfigToSave({ expr: '0 10 * * *', tz: 'Asia/Shanghai' }, stored)).toEqual({
      triggerConfig: { expr: '0 10 * * *', tz: 'Asia/Shanghai' },
    });
    expect(triggerConfigToSave({ expr: '0 9 * * *', tz: 'UTC' }, stored)).toEqual({
      triggerConfig: { expr: '0 9 * * *', tz: 'UTC' },
    });
    expect(triggerConfigToSave({ expr: '0 9 * * *' }, undefined)).toEqual({
      triggerConfig: { expr: '0 9 * * *' },
    });
  });
});
