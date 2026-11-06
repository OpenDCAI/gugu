import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { FileStorageDashboard } from '@/components/settings/FileStorageDashboard';
import { i18n } from '@/i18n';
import '@/i18n/registerSettingsCatalog';
import '@/styles/tokens.css';

const longName = 'a-file-name-long-enough-to-be-wider-than-any-phone-screen-without-a-single-space.png';
vi.mock('@/lib/fileStorage', () => ({
  markFileStorage: async () => 0,
  readFileStorageOverview: async () => ({
    total_bytes: 2_000_000_000,
    count: 3368,
    classes: { temporary: { bytes: 36_000_000, count: 60 }, image: { bytes: 238_000_000, count: 828 }, kept: { bytes: 1_700_000_000, count: 2480 } },
    groups: [{ chat_id: 'c1', name: 'a group with a rather long name', project: false, bytes: 1, count: 1 }],
    expiring: Array.from({ length: 6 }, (_, index) => ({ chat_id: 'c1', expires_at: '2099-01-01T00:00:00Z', bytes: 1000, class: 'temporary', item_id: `i${index}`, file_name: longName })),
    machines: [{ device_id: 'd1', label: 'a-machine-name-long-enough-to-be-wider-than-a-phone-screen', files: 17, bytes: 799_000, temporary_copy_bytes: 208_000 }],
    expiry: null,
    expiring_7d_bytes: 0,
  }),
}));

let harness: ReturnType<typeof createReactHarness>;
beforeEach(async () => {
  await page.viewport(360, 800);
  await i18n.changeLanguage('en-US');
  harness = createReactHarness();
  // The phone settings body: 16px of padding each side of a 360px screen.
  harness.container.style.cssText = 'width:328px;margin-left:16px;';
});
afterEach(() => harness.cleanup());

it('keeps the whole dashboard inside a phone-width container and leaves the file name a usable width', async () => {
  await renderWithAppProviders(harness, <FileStorageDashboard />);
  await until('the overview renders', () => harness.container.querySelector('[data-testid="file-storage-file"]') !== null);
  const past = [...harness.container.querySelectorAll('*')].filter((element) => element.getBoundingClientRect().right > window.innerWidth + 0.5);
  expect(past.map((element) => element.outerHTML.slice(0, 80))).toEqual([]);
  expect(harness.container.querySelector('[data-testid="file-storage-file"] td')!.getBoundingClientRect().width).toBeGreaterThan(300);
});
