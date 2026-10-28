import { describe, expect, it } from 'vitest';
import { buildIntegrationListPayload } from './integration-payload-builder';

/**
 * 插件自带中英两份,线上只走字符串(复核 93 ①):老桌面把描述、字段名、说明直接当文本画 ——
 * 对象会让 React 整页抛错。主进程按请求方的界面语言解析;没给 / 不认的语言 = en(老桌面不传)。
 */
describe('buildIntegrationListPayload — 按请求方的界面语言解析成字符串', () => {
  const forgejo = (locale?: string) => {
    const entry = buildIntegrationListPayload(locale).find((integration) => integration.id === 'forgejo');
    const form = entry?.auth.methods.find((method) => method.kind === 'form');
    return { entry, form: form?.kind === 'form' ? form : undefined };
  };

  it('线上只有字符串:哪种语言都没有 { en, zh-CN } 对象', () => {
    for (const locale of [undefined, 'zh-CN', 'en-US', 'ja-JP']) {
      const wire = JSON.stringify(buildIntegrationListPayload(locale));
      expect(wire, String(locale)).not.toContain('"zh-CN"');
    }
  });

  it('不传 locale(老桌面):英文,与改之前的清单同形', () => {
    const { entry, form } = forgejo();
    expect(entry?.description).toBe('Work on Forgejo issues');
    expect(form?.fields.map((field) => [field.label, field.placeholder])).toEqual([
      ['Instance URL', 'https://forgejo.example.com'],
      ['API token', 'API token'],
    ]);
    expect(form?.help).toBe('Create an API token in your Forgejo user settings under Applications.');
    expect(entry?.disconnectCredentialLabel).toBe('credentials');
  });

  it('zh-CN:中文', () => {
    const { entry, form } = forgejo('zh-CN');
    expect(entry?.description).toBe('处理 Forgejo issue');
    expect(form?.fields.map((field) => field.label)).toEqual(['实例地址', 'API 令牌']);
    expect(form?.help).toBe('在 Forgejo 用户设置的「应用」里新建一个 API 令牌。');
    expect(entry?.disconnectCredentialLabel).toBe('凭据');
  });

  it('钉钉先决条件按界面语言给出简短指引,链接原样带上', () => {
    const prerequisite = (locale?: string) => {
      const method = buildIntegrationListPayload(locale)
        .find((integration) => integration.id === 'dingtalk')
        ?.auth.methods.find((candidate) => candidate.kind === 'cli');
      return method?.kind === 'cli' ? method.prerequisite : undefined;
    };
    expect(prerequisite('zh-CN')).toEqual({
      text: '请先让组织管理员允许访问，再在钉钉确认授权。',
      url: 'https://open-dev.dingtalk.com',
    });
    expect(prerequisite()?.text).toMatch(/organization admin/i);
  });

  it('界面语言没有对应那一份:退回 en', () => {
    expect(forgejo('ja-JP').entry?.description).toBe('Work on Forgejo issues');
    expect(forgejo('en-US').entry?.description).toBe('Work on Forgejo issues');
  });
});
