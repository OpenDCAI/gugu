import { describe, expect, it } from 'vitest';
import { featuredBody, firstSentence, localizedManifestText } from './catalog';
import { EXTENSION_API_VERSION, safeParseExtensionManifest } from './manifest';

// owner 10-19:每个 App 名字下面那一句 = manifest 的 `subtitle`(可多语言),没写就退回简介第一句。
const base = { name: 'Radar', description: 'Lets an agent watch other agents. It pings the watcher.' };

describe('副标题 (owner 10-19)', () => {
  it('这种语言写了副标题就用它', () => {
    const manifest = { ...base, subtitle: 'Watch other agents', localized: { 'zh-CN': { subtitle: '关注别的 agent', description: '让 agent 关注别的 agent:它出问题时提醒。' } } };
    expect(localizedManifestText(manifest, 'zh-CN').subtitle).toBe('关注别的 agent');
    expect(localizedManifestText(manifest, 'en-US').subtitle).toBe('Watch other agents');
  });

  it('这种语言只写了简介:取简介第一句,❌ 拿另一种语言的副标题顶上', () => {
    const manifest = { ...base, subtitle: 'Watch other agents', localized: { 'zh-CN': { description: '让 agent 关注别的 agent:它出问题时提醒。' } } };
    expect(localizedManifestText(manifest, 'zh-CN').subtitle).toBe('让 agent 关注别的 agent');
  });

  it('谁都没写副标题:简介第一句;英文句点后面要有空白才算断句,版本号里的点不算', () => {
    expect(localizedManifestText(base, 'en-US').subtitle).toBe('Lets an agent watch other agents');
    expect(firstSentence('Supports v1.2 files. Fast.')).toBe('Supports v1.2 files');
    expect(firstSentence('全能搜索：网页搜索、读网页。')).toBe('全能搜索');
    expect(localizedManifestText({ name: 'X' }, 'zh-CN').subtitle).toBe('');
  });

  it('精选卡大字下面那两行:简介以副标题开头就去掉那一句;副标题另写的,简介整段都是', () => {
    expect(featuredBody('让 agent 关注别的 agent:它出问题时提醒。', '让 agent 关注别的 agent')).toBe('它出问题时提醒。');
    expect(featuredBody('它出问题时提醒。', '关注别的 agent')).toBe('它出问题时提醒。');
  });

  it('manifest:subtitle 和 localized 里的 subtitle 都收,30 字封顶', () => {
    const manifest = (extra: Record<string, unknown>) => ({
      id: 'radar',
      name: '雷达',
      version: '1.0.0',
      apiVersion: EXTENSION_API_VERSION,
      entry: 'index.html',
      contributes: { tabs: [{ name: 'main', title: '雷达' }] },
      ...extra,
    });
    expect(safeParseExtensionManifest(manifest({ subtitle: '关注别的 agent', localized: { en: { subtitle: 'Watch other agents' } } })).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest({ subtitle: 'x'.repeat(30) })).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest({ subtitle: 'x'.repeat(31) })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest({ localized: { en: { subtitle: 'x'.repeat(31) } } })).ok).toBe(false);
  });

  it('写了 subtitle 就要 apiVersion 8:只认得 7 的客户端(0.2.57-beta.113.1 / 115.1)拿到的是上一版,❌ 一份它拒收的 manifest', () => {
    const manifest = (apiVersion: number, extra: Record<string, unknown>) => ({
      id: 'radar', name: '雷达', version: '1.0.0', apiVersion, entry: 'index.html', contributes: { tabs: [{ name: 'main', title: '雷达' }] }, ...extra,
    });
    expect(safeParseExtensionManifest(manifest(7, { subtitle: '关注别的 agent' })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest(7, { localized: { en: { subtitle: 'Watch other agents' } } })).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest(7, {})).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest(8, { subtitle: '关注别的 agent' })).ok).toBe(true);
  });
});
