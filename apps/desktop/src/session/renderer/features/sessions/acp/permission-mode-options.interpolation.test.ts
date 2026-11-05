import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@/i18n';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { detachedPermissionModeOptions, localizePermissionModeOptions } from './permission-mode-options';
const codexPermissionModes = { 'read-only': { id: ':read-only' }, edit: { id: ':workspace' } };

// Exercise the production translator, not a stub that merely echoes message keys.
describe('permission description interpolation', () => {
  afterEach(async () => { await i18n.changeLanguage('zh-CN'); });

  it.each(['zh-CN', 'en-US'] as const)('names the agent in live and detached %s options', async locale => {
    await i18n.changeLanguage(locale);
    const options = { ':read-only': { name: 'read-only' }, ':workspace': { name: 'workspace' } };
    for (const agentName of ['Codex', 'Named Agent']) {
      const detached = detachedPermissionModeOptions('read-only', codexPermissionModes)!;
      for (const reported of [options, detached.options]) {
        const shown = localizePermissionModeOptions(reported, translateSessionMessage, agentName, codexPermissionModes);
        expect(shown?.[':read-only'].description).toContain(agentName);
        expect(shown?.[':read-only'].description).not.toMatch(/\{[^}]+\}/);
      }
    }
  });
});
