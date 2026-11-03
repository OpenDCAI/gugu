import { useRef } from 'react';
import { runInAction } from 'mobx';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { i18n } from '@/i18n';
import { rendererLogger } from '@/lib/log';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { GroupAppsPicker } from '@/components/chat/GroupAppsPicker';
import { Popover } from '@/components/ui/Popover';
import { installedExtensionsStore } from '../../features/extensions/installed-extensions-store';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../shared/extensions/manifest';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
let viewport: { width: number; height: number };
let language: string;
let manifests: typeof installedExtensionsStore.manifests;
let disabled: typeof installedExtensionsStore.disabled;
beforeEach(async () => {
  viewport = { width: innerWidth, height: innerHeight }; language = i18n.language;
  manifests = installedExtensionsStore.manifests; disabled = installedExtensionsStore.disabled;
  await page.viewport(1000, 700); await i18n.changeLanguage('en-US');
  harness = createReactHarness();
});
afterEach(async () => {
  harness.cleanup();
  runInAction(() => { installedExtensionsStore.manifests = manifests; installedExtensionsStore.disabled = disabled; });
  await i18n.changeLanguage(language); await page.viewport(viewport.width, viewport.height);
});

function Picker() {
  const anchor = useRef<HTMLButtonElement>(null);
  return <Popover.Root open modal={false}>
    <Popover.Trigger ref={anchor} style={{ margin: 40 }}>Apps</Popover.Trigger>
    <GroupAppsPicker chatId="width-fixture" anchor={anchor} onClose={() => {}} />
  </Popover.Root>;
}

async function measure(name: string) {
  runInAction(() => {
    installedExtensionsStore.manifests = [parseExtensionManifest({ id: 'width-app', name, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: name }] } })];
    installedExtensionsStore.disabled = [];
  });
  await renderWithAppProviders(harness, <Picker />);
  await until('the actual Apps picker and row are laid out', () => (document.querySelector('[data-app-id="width-app"]')?.getBoundingClientRect().width ?? 0) > 0);
  expect(document.querySelectorAll('[data-slot="popover-popup"]')).toHaveLength(1);
  const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
  expect(popup.querySelector('.truncate')?.textContent).toBe(name);
  await document.fonts.ready;
  await until('the picker entry transition has settled before measuring layout width', () => !popup.hasAttribute('data-starting-style') && Math.abs(popup.getBoundingClientRect().width - parseFloat(getComputedStyle(popup).width)) < 0.1);
  await untilStable('the real picker layout width is stable', () => popup.getBoundingClientRect().width);
  const width = popup.getBoundingClientRect().width;
  const spacing = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing'));
  // The theme spacing token is rem-based; resolve it through the root font size.
  const unit = spacing * parseFloat(getComputedStyle(document.documentElement).fontSize);
  rendererLogger('tests/group-apps-picker-width').info({ name, viewport: innerWidth, width, minWidth: getComputedStyle(popup).minWidth, maxWidth: getComputedStyle(popup).maxWidth, minimum: 40 * unit, maximum: Math.min(80 * unit, innerWidth - 4 * unit) }, 'GROUP_APPS_PICKER_WIDTH');
  return { popup, width, unit };
}

it('[immediate] hugs short App names and grows for long names in the same picker', async () => {
  const short = await measure('A');
  const long = await measure('W'.repeat(48));
  expect(short.width).toBeGreaterThan(0);
  expect(short.width, 'short picker content must grow with long names').toBeLessThan(long.width);
  expect(short.width).toBeGreaterThanOrEqual(40 * short.unit);
  expect(long.width).toBeLessThanOrEqual(Math.min(320, innerWidth - 16));
});

it('[immediate control] preserves the old maximum at a narrow viewport and truncates a long App name', async () => {
  await page.viewport(320, 700);
  const { popup, width } = await measure('W'.repeat(48));
  expect(width).toBeCloseTo(Math.min(320, innerWidth - 16), 0);
  const label = popup.querySelector<HTMLElement>('.truncate')!;
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
});
