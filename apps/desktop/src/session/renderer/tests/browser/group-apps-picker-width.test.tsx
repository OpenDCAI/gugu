import { useRef } from 'react';
import { runInAction } from 'mobx';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { GroupAppsPicker } from '@/components/chat/GroupAppsPicker';
import { Popover } from '@/components/ui/Popover';
import { installedExtensionsStore } from '../../features/extensions/installed-extensions-store';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../shared/extensions/manifest';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { harness = createReactHarness(); });
afterEach(() => {
  harness.cleanup();
  runInAction(() => { installedExtensionsStore.manifests = []; installedExtensionsStore.disabled = []; });
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
  const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
  const width = popup.getBoundingClientRect().width;
  const spacing = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing'));
  // The theme spacing token is rem-based; resolve it through the root font size.
  const unit = spacing * parseFloat(getComputedStyle(document.documentElement).fontSize);
  console.info('GROUP_APPS_PICKER_WIDTH', JSON.stringify({ name, width, minimum: 40 * unit, maximum: Math.min(80 * unit, innerWidth - 4 * unit) }));
  return { popup, width, unit };
}

it('[immediate] hugs short App names instead of stretching the picker to its maximum', async () => {
  const { width, unit } = await measure('Go');
  expect(width, 'the existing theme spacing token resolves').toBeGreaterThan(0);
  expect(width).toBeGreaterThanOrEqual(40 * unit);
  expect(width, 'short picker content must not occupy the full maximum').toBeLessThan(80 * unit);
});

it('[immediate control] preserves the maximum and truncates a long App name inside the picker', async () => {
  const { popup, width, unit } = await measure('A very long installed application name '.repeat(8));
  expect(width).toBeCloseTo(Math.min(80 * unit, innerWidth - 4 * unit), 0);
  const label = popup.querySelector<HTMLElement>('.truncate')!;
  expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth);
});
