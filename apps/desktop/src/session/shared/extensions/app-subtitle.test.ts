import { describe, expect, it } from 'vitest';
import { localizedManifestText, manifestLanguages } from './catalog';
import { EXTENSION_API_VERSION, safeParseExtensionManifest } from './manifest';

// App 模型 v2:名字下面那一句 = manifest 的 `subtitle`(可多语言),没写就是空的,❌ 回落;主字段的语言是 `defaultLocale`。
const base = { name: 'Radar', defaultLocale: 'en' };

describe('副标题与语言 (App 模型 v2)', () => {
  it('这种语言写了副标题就用它;是 defaultLocale 的语言就是主字段', () => {
    const manifest = { ...base, subtitle: 'Watch other agents', localized: { 'zh-CN': { name: '雷达', subtitle: '关注别的 agent' } } };
    expect(localizedManifestText(manifest, 'zh-CN')).toMatchObject({ name: '雷达', subtitle: '关注别的 agent' });
    expect(localizedManifestText(manifest, 'en-US')).toMatchObject({ name: 'Radar', subtitle: 'Watch other agents' });
  });

  it('这种语言没写副标题:空的,❌ 拿另一种语言的顶上;没写副标题的 App 也是空的', () => {
    const manifest = { ...base, subtitle: 'Watch other agents', localized: { 'zh-CN': { name: '雷达' } } };
    expect(localizedManifestText(manifest, 'zh-CN').subtitle).toBe('');
    expect(localizedManifestText(base, 'en-US').subtitle).toBe('');
  });

  it('产品页的语言:界面语言写了的那格打头,没有就是 defaultLocale;每格都有语言名', () => {
    const manifest = { defaultLocale: 'zh-CN', localized: { en: {} } };
    expect(manifestLanguages(manifest, 'en-US')).toEqual([{ locale: 'en', language: 'en' }, { locale: 'zh-CN', language: 'zh' }]);
    expect(manifestLanguages(manifest, 'zh-CN')).toEqual([{ locale: 'zh-CN', language: 'zh' }, { locale: 'en', language: 'en' }]);
    expect(manifestLanguages({ defaultLocale: 'en' }, 'zh-CN')).toEqual([{ locale: 'en', language: 'en' }]);
  });

  it('manifest:subtitle 和 localized 里的 subtitle 都收,30 字封顶;localized 不重写 defaultLocale 的语言', () => {
    const manifest = (extra: Record<string, unknown>) => ({
      id: 'radar',
      name: '雷达',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION, defaultLocale: 'zh-CN',
      entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: '雷达' }] },
      ...extra,
    });
    expect(safeParseExtensionManifest(manifest({ subtitle: '关注别的 agent', localized: { en: { subtitle: 'Watch other agents' } } })).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest({ subtitle: 'x'.repeat(30) })).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest({ subtitle: 'x'.repeat(31) })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest({ localized: { en: { subtitle: 'x'.repeat(31) } } })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest({ localized: { zh: { subtitle: '雷达' } } })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest({ defaultLocale: undefined })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest({ description: '旧字段' })).ok).toBe(false);
  });
});
