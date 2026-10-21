import { describe, expect, it } from 'vitest';
import { listUserExposedPlugins, pluginRegistry } from '../registry';
import { WITHHELD_FAMILIES } from './p0-families';

describe('上架闸的 model 维(#6335)', () => {
  it('厂商点不了名的家(model 如实声明 unsupported-channel)照样上架 —— antigravity 只能走订阅', () => {
    expect(listUserExposedPlugins().map((provider) => provider.metadata.id)).toContain('antigravity');
  });

  it('放宽不改变任何别家的上架:声明 unsupported-channel 的其余家都在不上架名单里', () => {
    const withheld = new Set<string>(WITHHELD_FAMILIES);
    const unsupportedModel = pluginRegistry.getAll().filter((provider) => {
      const model = provider.capabilities.sessionBundle?.units.model;
      return model?.kind === 'none' && model.degraded.code === 'unsupported-channel';
    });
    expect(unsupportedModel.map((provider) => provider.metadata.id).filter((id) => id !== 'antigravity' && !withheld.has(id)))
      .toEqual([]);
  });
});

describe('上架名单', () => {
  // 用户在 agent 列表、composer、资源库「智能体」页看得到的就是这几家。增删是 owner 的产品决定
  // (WITHHELD_FAMILIES 抬头),这条测试让每一次上架 / 下架都在 diff 里露面。
  // owner 2026-10-18「zcode 这条线该端上来就端上来」⇒ zcode 上架,第 10 家(#7385)。
  // owner 2026-10-19「1 上架」⇒ CodeBuddy Code 上架,第 11 家(#7525)。
  it('owner 拍板的 11 家', () => {
    expect(listUserExposedPlugins().map((provider) => provider.metadata.id).sort()).toEqual([
      'antigravity',
      'claude',
      'codebuddy',
      'codex',
      'copilot',
      'hermes',
      'mimocode',
      'opencode',
      'pi',
      'qwen',
      'zcode',
    ]);
  });
});
