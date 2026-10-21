import { describe, expect, it } from 'vitest';
import { planModelSwitch } from './model-switch-plan';

const reloadRequired = {
  channel: 'reload-session' as const,
  ack: 'none' as const,
  busy: 'reject' as const,
  reloadRequired: true,
  recovery: 'runtime-restart' as const,
};

describe('planModelSwitch', () => {
  it('routes a catalog model through explicit restart when the provider requires it', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5.2' },
      advertised: ['glm-5.2'],
      catalog: [{ id: 'glm-5.2', displayName: 'GLM 5.2' }],
      runningOn: 'platform',
      liveSetting: reloadRequired,
    })).toEqual({
      kind: 'reload',
      modelId: 'glm-5.2',
      displayName: 'GLM 5.2',
      source: 'platform',
    });
  });

  it('does not offer a model when the provider has no restart recovery contract', () => {
    expect(planModelSwitch({
      selection: { source: 'own', modelId: 'provider-model' },
      advertised: ['provider-model'],
      catalog: [],
      runningOn: 'own',
      liveSetting: { ...reloadRequired, recovery: 'unsupported', channel: 'unsupported' },
    }).kind).toBe('unsupported');
  });
});

/**
 * 热切一条平台模型时,**下发值必须是这一家自己的寻址形式**。
 *
 * 这一条守的是本次缺陷的正身:递裸 `glm-5` 给 opencode 会被它当未知模型拒
 * (实测 `-32602 model not found`),而 `gugu-platform/glm-5` 才是 success。
 * ⚠️ 判据钉的是「值从活会话自报的清单里来」——❌ 别改成断言字符串以 `gugu-platform/` 开头:
 * 那会把「第二份前缀字面量」这件正要禁掉的事又写进判据里。
 */
describe('planModelSwitch — 平台模型的下发值', () => {
  const hotPlatform = {
    channel: 'acp-config-option' as const,
    ack: 'ack-read-back' as const,
    busy: 'reject' as const,
    reloadRequired: false,
    recovery: 'none' as const,
  };

  it('takes the wire value from the live session own advertised addressing', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5' },
      // 活会话报的是平台限定形式 —— 与注进去的那份配置文档同一个真值。
      advertised: ['opencode/big-pickle', 'gugu-platform/glm-5', 'gugu-platform/glm-5.2'],
      catalog: [{ id: 'glm-5', displayName: 'GLM 5' }],
      runningOn: 'platform',
      liveSetting: hotPlatform,
    })).toEqual({ kind: 'hot', modelId: 'glm-5', wireValue: 'gugu-platform/glm-5' });
  });

  it('keeps the canonical id when the live session advertises it bare', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5' },
      advertised: ['glm-5'],
      catalog: [{ id: 'glm-5', displayName: 'GLM 5' }],
      runningOn: 'platform',
      liveSetting: hotPlatform,
    })).toEqual({ kind: 'hot', modelId: 'glm-5', wireValue: 'glm-5' });
  });

  /**
   * 报不出来时**不换通道**:把规范 id 交给 ACP,让 provider 的原始错误到 UI。
   * ❌ 不许在这里回落成 reload —— 那会把「启动注入漏了这条模型」这个缺口盖掉。
   */
  it('falls back to the canonical id so the provider error surfaces', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5' },
      advertised: ['opencode/big-pickle'],
      catalog: [{ id: 'glm-5', displayName: 'GLM 5' }],
      runningOn: 'platform',
      liveSetting: hotPlatform,
    })).toEqual({ kind: 'hot', modelId: 'glm-5', wireValue: 'glm-5' });
  });

  /**
   * BYOK 会话里与平台目录**同名**的那条,是另一条真凭据路径 —— 下发值就是清单里那条,
   * ❌ 不许被加上平台前缀(owner 边界 ②:编码认路由,不是见了裸 id 就加前缀)。
   */
  it('never platform-qualifies a BYOK model that shares the name', () => {
    expect(planModelSwitch({
      selection: { source: 'own', modelId: 'glm-5' },
      advertised: ['glm-5', 'gugu-platform/glm-5'],
      catalog: [{ id: 'glm-5', displayName: 'GLM 5' }],
      runningOn: 'own',
      liveSetting: hotPlatform,
    })).toEqual({ kind: 'hot', modelId: 'glm-5', wireValue: 'glm-5' });
  });
});

/**
 * #6182 copilot 那一格:没声明模型这一维,菜单却把同路的模型摆成「能当场换」,
 * 点下去 cell 才以 `LiveSettingUndeclared` 拒。planner 与 cell 读同一个事实 ⇒ 未声明 = 没有活通道。
 */
describe('planModelSwitch — 未声明模型这一维', () => {
  it('does not offer a same-route platform switch as hot', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5.3-flash' },
      advertised: [],
      catalog: [{ id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash' }],
      runningOn: 'platform',
    })).toEqual({ kind: 'unsupported', modelId: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash' });
  });

  it('does not offer a same-route BYOK switch as hot', () => {
    expect(planModelSwitch({
      selection: { source: 'own', modelId: 'provider-model' },
      advertised: ['provider-model'],
      catalog: [],
      runningOn: 'own',
    }).kind).toBe('unsupported');
  });

  // 跨计费路不经活通道(换进程换端点换凭据),声明与否都走重开。
  it('still reloads across billing routes', () => {
    expect(planModelSwitch({
      selection: { source: 'platform', modelId: 'glm-5.3-flash' },
      advertised: [],
      catalog: [{ id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash' }],
      runningOn: 'own',
    })).toEqual({ kind: 'reload', modelId: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', source: 'platform' });
  });
});
