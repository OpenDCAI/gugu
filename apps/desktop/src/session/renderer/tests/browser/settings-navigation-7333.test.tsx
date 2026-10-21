import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { SettingsNav } from '@/components/settings/SettingsNav';
import type { AuthUser } from '@/store/auth';
import { SETTINGS_SECTIONS, type ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels';
import { i18n } from '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/i18n/registerSettingsCatalog';
import '@/components/settings/settings.css';
import '@/styles/tokens.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
const { SettingsPanel } = await import('@/components/SettingsPanel');

const desktopSections = SETTINGS_SECTIONS.filter((section) => section !== 'apps' && section !== 'phone');
const nickname = '一个名称很长但仍能完整访问的验收账号';
const user: AuthUser = { id: 'settings-7333', nickname, gugu_number: 7333, email: 'settings@example.com' };
let harness: ReturnType<typeof createReactHarness>;
let previousTheme: string | undefined;
function NavHost() {
  const [section, setSection] = useState<ActiveSection>('general');
  return <SettingsNav user={user} sections={desktopSections} activeSection={section} onSelect={setSection} />;
}
const tier = (element: Element) => {
  const style = getComputedStyle(element);
  return [Number.parseFloat(style.fontSize), Number.parseFloat(style.lineHeight), style.fontWeight];
};
beforeEach(async () => {
  await page.viewport(1200, 900);
  await i18n.changeLanguage('zh-CN');
  // Production Vite supplies this build constant; keep the real About section in this test.
  vi.stubGlobal('__APP_VERSION__', 'test-version');
  previousTheme = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = 'light';
  harness = createReactHarness();
  harness.container.style.cssText = 'display:flex;width:216px;height:760px;';
});
afterEach(() => {
  harness.cleanup();
  vi.unstubAllGlobals();
  if (previousTheme) document.documentElement.dataset.theme = previousTheme;
  else delete document.documentElement.dataset.theme;
});

describe('settings navigation hierarchy and interaction (#7333)', () => {
  it.each(['light', 'dark'])('the full desktop menu fits the normal dialog height with one restrained current item in %s', async (theme) => {
    document.documentElement.dataset.theme = theme;
    await renderWithAppProviders(harness, <NavHost />);
    const pane = harness.container.querySelector<HTMLElement>('[data-slot="pane"][data-role="nav"]')!;
    const scroll = pane.querySelector<HTMLElement>('.gg-settings-nav-scroll')!;
    const rows = pane.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]');
    expect(pane.getBoundingClientRect().width).toBe(216);
    expect(rows).toHaveLength(17);
    expect(pane.querySelector('[data-testid="settings-nav-resource-monitor"]')?.textContent).toBe('资源监视器');
    expect(scroll.clientHeight).toBeGreaterThan(600);
    expect(scroll.scrollHeight).toBeLessThanOrEqual(scroll.clientHeight + 1);
    expect(pane.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const current = pane.querySelector<HTMLElement>('[data-testid="settings-nav-general"]')!;
    const ordinary = pane.querySelector<HTMLElement>('[data-testid="settings-nav-browser"]')!;
    expect(current.getBoundingClientRect().height).toBe(32);
    expect(tier(current.querySelector('.gg-list-row-title')!)).toEqual([14, 20, '500']);
    expect(tier(ordinary.querySelector('.gg-list-row-title')!)).toEqual([14, 20, '400']);
    expect(ordinary.querySelector('svg')!.getBoundingClientRect().width).toBe(16);
    expect(getComputedStyle(current).backgroundColor).not.toBe(getComputedStyle(ordinary).backgroundColor);
    const identity = pane.querySelector<HTMLElement>('.gg-settings-identity')!;
    const name = identity.querySelector<HTMLElement>('.gg-settings-identity-name')!;
    expect(identity.getBoundingClientRect().height).toBeLessThanOrEqual(60);
    expect(tier(name)).toEqual([14, 20, '500']);
    expect(name.title).toBe(nickname);
    expect(name.clientWidth).toBeGreaterThan(80);
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
    expect(tier(identity.querySelector('.gg-settings-identity-id')!)).toEqual([12, 18, '400']);
  });

  it('the real navigation responds to keyboard and copy keeps the original number', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    await renderWithAppProviders(harness, <NavHost />);
    const account = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-account"]')!;
    account.focus();
    await userEvent.keyboard('{Enter}');
    await until('Enter changes the active section', () => account.getAttribute('aria-current') === 'page');
    await userEvent.tab();
    const usage = harness.container.querySelector<HTMLElement>('[data-testid="settings-nav-usage"]')!;
    expect(document.activeElement).toBe(usage);
    expect(usage.matches(':focus-visible')).toBe(true);
    expect(getComputedStyle(usage).outlineStyle).toBe('solid');
    await userEvent.keyboard(' ');
    await until('Space changes the active section', () => usage.getAttribute('aria-current') === 'page');
    expect(account.hasAttribute('aria-current')).toBe(false);
    await page.getByRole('button', { name: i18n.t('actions.copy'), exact: true }).click();
    expect(copy).toHaveBeenCalledExactlyOnceWith('7333');
  });

  it('the phone Me list retains full-sized rows, its back action and unselected navigation', async () => {
    await page.viewport(412, 820);
    harness.container.style.width = '412px';
    const onSelect = vi.fn();
    const onBack = vi.fn();
    await renderWithAppProviders(harness, <SettingsNav user={user} sections={['account', 'general', 'about']} activeSection="general" mobile onSelect={onSelect} onBack={onBack} />);
    const rows = harness.container.querySelectorAll<HTMLElement>('[data-testid^="settings-nav-"]');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expect(row.hasAttribute('aria-current')).toBe(false);
    }
    await page.getByRole('button', { name: i18n.t('settings.nav.general', { ns: 'main' }), exact: true }).click();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('general');
    await page.getByRole('button', { name: i18n.t('settings.back', { ns: 'main' }), exact: true }).click();
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it.each([1200, 900])('the real settings panel aligns every page heading with its reading column at %ipx', async (width) => {
    await page.viewport(width, 900);
    await renderWithAppProviders(harness, <SettingsPanel initialSection="general" onClose={vi.fn()} />, { auth: null, contacts: {} });
    const detail = document.querySelector<HTMLElement>('[data-settings-modal-card] [data-role="detail"]')!;
    const dialog = detail.closest<HTMLElement>('[role="dialog"]')!;
    await until('the real settings dialog finished entering', () => dialog.getAnimations({ subtree: true }).every((animation) => animation.playState === 'finished'));
    const verify = () => {
      const title = detail.querySelector<HTMLElement>('[data-slot="pane-header"] h2')!;
      const column = detail.querySelector<HTMLElement>('.gg-settings-body > *')!;
      expect(detail.getBoundingClientRect().width).toBeGreaterThan(550);
      expect(column.getBoundingClientRect().width).toBeGreaterThan(500);
      expect(column.getBoundingClientRect().width).toBeLessThanOrEqual(720);
      expect(title.getBoundingClientRect().left).toBeCloseTo(column.getBoundingClientRect().left, 0);
      expect(tier(title)).toEqual([20, 28, '600']);
    };
    verify();
    await page.getByRole('button', { name: i18n.t('settings.nav.about', { ns: 'main' }), exact: true }).click();
    await until('About opens in the same dialog', () => !detail.isConnected || document.querySelector('[data-settings-modal-card]')?.getAttribute('data-settings-section') === 'about');
    expect(detail.isConnected, 'navigating to About must not unmount the settings panel').toBe(true);
    verify();
    expect(document.querySelectorAll('[data-settings-modal-card]')).toHaveLength(1);
  });
});
