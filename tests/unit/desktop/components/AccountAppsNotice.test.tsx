// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNode, createReactHarness, clickElement } from '../../../support/testHarness';
import { i18n } from '../../../../apps/desktop/src/i18n/runtime';
import { AccountAppsNotice } from '../../../../apps/desktop/src/session/renderer/features/extensions/panel/account-apps-notice';

beforeEach(async () => { await i18n.changeLanguage('zh-CN'); });

describe('account App restoration notices', () => {
  it('keeps successful installs and a local uninstall quiet, without an empty status container', async () => {
    const h = createReactHarness();
    try {
      await h.render(createNode(AccountAppsNotice, {
        apps: [{ id: 'browser-use', state: 'installed' }, { id: 'browser-use', state: 'excluded' }],
        onReview: vi.fn(), onRetry: vi.fn(),
      }));
      expect(h.container.querySelector('[role="status"]')).toBeNull();
      expect(h.container.textContent).toBe('');
    } finally { h.cleanup(); }
  });

  it('offers actual review when the recorded version or capabilities need confirmation', async () => {
    const h = createReactHarness(); const review = vi.fn();
    try {
      await h.render(createNode(AccountAppsNotice, {
        apps: [{ id: 'browser-use', state: 'needs-consent', reason: 'internal manifest digest changed' }],
        onReview: review, onRetry: vi.fn(),
      }));
      expect(h.container.textContent).toContain('安装 Browser Use 前，需要确认权限。');
      expect(h.container.textContent).not.toContain('manifest');
      await clickElement(h.container.querySelector('button')!);
      expect(review).toHaveBeenCalledExactlyOnceWith('browser-use');
    } finally { h.cleanup(); }
  });

  it('shows a real unavailable state without presenting a retry as permission', async () => {
    const h = createReactHarness();
    try {
      await h.render(createNode(AccountAppsNotice, {
        apps: [{ id: 'browser-use', state: 'unavailable', reason: 'Host capability is unavailable: browser-use' }],
        onReview: vi.fn(), onRetry: vi.fn(),
      }));
      expect(h.container.textContent).toBe('这台机器暂不支持 Browser Use。');
      expect(h.container.querySelector('button')).toBeNull();
    } finally { h.cleanup(); }
  });

  it('offers retry after a failed download and interpolates the App name in English too', async () => {
    await i18n.changeLanguage('en-US');
    const h = createReactHarness(); const retry = vi.fn();
    try {
      await h.render(createNode(AccountAppsNotice, {
        apps: [{ id: 'browser-use', state: 'failed' }], onReview: vi.fn(), onRetry: retry,
      }));
      expect(h.container.textContent).toContain('Browser Use could not be installed here.');
      expect(h.container.textContent).not.toContain('{');
      await clickElement(h.container.querySelector('button')!);
      expect(retry).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });
});
