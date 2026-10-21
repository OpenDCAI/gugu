import { describe, expect, it } from 'vitest';
import { localizedTextSchema } from './localized-text';
import { integrationPluginRegistry } from './registry';

/**
 * 插件写给人看的那几格只收 `{ en, 'zh-CN' }`(10-07 资源库修复,125 定:❌ 留纯字符串的兼容口子)。
 * 这里钉两件事:schema 拒收纯字符串;21 家每一格都带齐两份(12 家 + #7210 飞书、腾讯文档、滴答清单、钉钉、企业微信 + #7240 三家邮箱 + #7490 腾讯会议),
 * 含 #7240 的「能力」「推荐玩法」。
 */
describe('integration copy is { en, zh-CN } everywhere', () => {
  it('a plain string is refused', () => {
    expect(localizedTextSchema.safeParse('Work on GitLab issues').success).toBe(false);
    expect(localizedTextSchema.safeParse({ en: 'x' }).success).toBe(false);
    expect(localizedTextSchema.safeParse({ en: 'x', 'zh-CN': 'y' }).success).toBe(true);
  });

  it('every registered integration carries both for description, field labels, placeholders, help and prerequisites', () => {
    const plugins = integrationPluginRegistry.getAll();
    expect(plugins.length).toBe(21);
    for (const plugin of plugins) {
      const texts = [
        plugin.metadata.description,
        ...(plugin.metadata.abilities ?? []),
        ...(plugin.metadata.playbooks ?? []).flatMap((playbook) => [playbook.title, playbook.prompt]),
        ...plugin.capabilities.auth.methods.flatMap((method) =>
          method.kind === 'form'
            ? [
                ...method.fields.flatMap((field) => [field.label, ...(field.placeholder ? [field.placeholder] : [])]),
                ...(method.help ? [method.help] : []),
              ]
            : method.kind === 'cli' && method.prerequisite
              ? [method.prerequisite.text]
              : []
        ),
      ];
      for (const text of texts) {
        expect(localizedTextSchema.safeParse(text).success, `${plugin.metadata.id}: ${JSON.stringify(text)}`).toBe(true);
      }
    }
  });
});
