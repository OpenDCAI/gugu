import { describe, expect, it } from 'vitest';
import { localizedTabText } from './catalog';
import { safeParseExtensionManifest } from './manifest';

const base = {
  id: 'kanban', name: '协作看板', version: '1.0.0', apiVersion: 25, defaultLocale: 'zh-CN', entry: 'index.html',
  contributes: { tabs: [{ name: 'board', title: '看板', toolbar: [{ id: 'new', title: '新卡片' }] }] },
};

// API 25: a tab's title and its toolbar commands are written per language under `localized`, read through one lookup.
describe('localized tab titles and toolbar commands', () => {
  it('a reader in a listed language gets them; one in defaultLocale, or with none written, the base', () => {
    const parsed = safeParseExtensionManifest({ ...base, localized: { en: { name: 'Teamboard', tabs: { board: { title: 'Board', toolbar: { new: 'New card' } } } } } });
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    const tab = parsed.manifest.contributes.tabs[0]!;
    expect(localizedTabText(parsed.manifest, tab, 'en-US')).toEqual({ title: 'Board', toolbar: [{ id: 'new', title: 'New card' }] });
    expect(localizedTabText(parsed.manifest, tab, 'zh-CN')).toEqual({ title: '看板', toolbar: [{ id: 'new', title: '新卡片' }] });
    expect(localizedTabText(parsed.manifest, tab, 'fr')).toEqual({ title: '看板', toolbar: [{ id: 'new', title: '新卡片' }] });
  });

  it('a tab or a command the App does not declare is refused, said which', () => {
    const issues = (localized: unknown) => {
      const parsed = safeParseExtensionManifest({ ...base, localized });
      return parsed.ok ? [] : parsed.issues.join('\n');
    };
    expect(issues({ en: { tabs: { bored: { title: 'Board' } } } })).toContain('no tab named bored');
    expect(issues({ en: { tabs: { board: { toolbar: { nwe: 'New card' } } } } })).toContain('no toolbar command nwe');
  });
});
