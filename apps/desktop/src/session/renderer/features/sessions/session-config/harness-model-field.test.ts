import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLocaleSnapshot, setLocalePreference } from '@/i18n';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { harnessCatalogNotice } from './harness-model-field';

const initialLocale = getLocaleSnapshot().preference;
afterEach(() => setLocalePreference(initialLocale));

describe('harnessCatalogNotice:#6264 登录已失效', () => {
  it('登录已失效说「登录已失效」,❌ 说成需要先登录', () => {
    expect(
      harnessCatalogNotice({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null, expired: true }, 'Codex', translateSessionMessage)
    ).toMatchObject({ key: 'harnessCatalog.authExpired', values: { name: 'Codex' }, action: 'login' });
  });

  it('从没登录过照旧', () => {
    expect(
      harnessCatalogNotice({ kind: 'auth-required', authMethods: [], efforts: [], selectedEffort: null }, 'Codex', translateSessionMessage)
    ).toMatchObject({ key: 'harnessCatalog.authRequired' });
  });
});

describe('harnessCatalogNotice: probe failure localization', () => {
  it('uses the current locale and display name for the same terminal failure', () => {
    const state = { kind: 'unavailable', reason: 'Model catalog probe failed', reasonCode: 'probe-failed' } as const;
    setLocalePreference('en-US');
    const english = harnessCatalogNotice(state, 'Pi', translateSessionMessage);
    expect(english?.detail).toContain("Couldn't read Pi's model catalog");
    expect(english?.detail).toContain('Gugu gateway model');
    expect(english?.detail).toContain('Pi sign-in');
    expect(english?.detail).not.toMatch(/[\u4e00-\u9fff]/);

    setLocalePreference('zh-CN');
    const chinese = harnessCatalogNotice(state, 'Pi', translateSessionMessage);
    expect(chinese?.detail).toContain('无法读取 Pi 的模型目录');
    expect(chinese?.detail).toContain('咕咕网关的模型');
    expect(chinese?.detail).toContain('Pi 的登录状态');
  });

  it('preserves an external failure reason without classifying it as a probe exception', () => {
    const translate = vi.fn();
    expect(harnessCatalogNotice({ kind: 'unavailable', reason: 'ACP protocol rejected' }, 'Pi', translate))
      .toMatchObject({ detail: 'ACP protocol rejected', action: 'retry' });
    expect(translate).not.toHaveBeenCalled();
  });
});
