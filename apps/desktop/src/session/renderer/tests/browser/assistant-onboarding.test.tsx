import { expect, it, vi, afterEach } from 'vitest';
import { page } from 'vitest/browser';
import { createReactHarness, clickElement } from '../../../../../../../tests/support/testHarness';
import { FirstRunGate } from '@/components/firstRun/FirstRunGate';
import { AssistantOnboarding } from '@/components/assistant/AssistantOnboarding';
import { i18n } from '@/i18n';
import '@/styles/tokens.css';

const services = vi.hoisted(() => ({ kind: 'web' as 'web' | 'capacitor', membership: vi.fn(async () => null) }));
vi.mock('@/platform', async original => {
  const actual = await original<typeof import('@/platform')>();
  return { ...actual, platform: { ...actual.platform, get kind() { return services.kind; } } };
});
vi.mock('@/lib/billing/membership', () => ({ getMembership: services.membership }));
vi.mock('@/lib/firstRun', async original => ({
  ...await original<object>(),
  readFirstRunProgress: async () => ({ stage: 'done', occupation: { key: 'research' }, harness: [], tour: null }),
}));
vi.mock('@/mobile/phone-device/nativePhoneActions', async original => ({
  ...await original<object>(), nativePhoneActions: { deviceInfo: async () => ({ install_key: 'setup-test-phone' }) },
}));

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => { harness?.cleanup(); vi.clearAllMocks(); });

// Keep the real first-run provider tree and onboarding steps; only account/native reads are replaced.
it.each(['web', 'capacitor'] as const)('continues to home choices on %s outside the session page', async kind => {
  services.kind = kind;
  await page.viewport(390, 844);
  harness = createReactHarness();
  const user = { id: 'setup-owner', nickname: 'Researcher', email: 'researcher@example.test', avatarUrl: null };
  await harness.render(<FirstRunGate user={user}>
    <AssistantOnboarding ownerUserId={user.id} ownerName={user.nickname} snapshot={null} device={null}
      cloudAvailable={true} localDeviceId={null} />
  </FirstRunGate>);
  await clickElement(harness.container.querySelector('[data-testid="assistant-intro-primary"]')!);
  await expect.element(page.getByRole('textbox')).toBeVisible();
  const next = [...harness.container.querySelectorAll('button')].find(button => button.textContent === i18n.t('setup.continue', { ns: 'assistant' }))!;
  await clickElement(next);
  await expect.element(page.getByTestId('assistant-setup-home-nocomputer')).toBeVisible();
  await expect.element(page.getByTestId('assistant-setup-member')).toBeVisible();
  expect(services.membership).toHaveBeenCalled();
});
