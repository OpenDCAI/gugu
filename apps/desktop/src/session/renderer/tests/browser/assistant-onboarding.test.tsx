import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { AssistantOnboarding } from '@/components/assistant/AssistantOnboarding';
import '@/styles/tokens.css';

const services = vi.hoisted(() => ({
  membership: vi.fn(async () => null),
  refresh: vi.fn(async () => undefined),
}));
vi.mock('@/lib/billing/membership', () => ({ getMembership: services.membership }));
vi.mock('@/lib/cloudComputerStore', async original => ({
  ...await original<object>(), refreshCloudComputer: services.refresh,
}));
vi.mock('@gugu/core/cloud/optionalServices', async original => ({
  ...await original<object>(), cloudComputerEnabled: () => true,
}));

let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.clearAllMocks();
});

// The phone shell and global settings mount onboarding outside the session page's providers.
it.each([null, 'local-device'])('continues to home choices without a session query provider (device: %s)', async localDeviceId => {
  await page.viewport(localDeviceId ? 1200 : 390, 844);
  host = document.createElement('div');
  document.body.append(host);
  const errors: unknown[] = [];
  root = createRoot(host, { onUncaughtError: error => errors.push(error) });
  await act(async () => root.render(<AssistantOnboarding
    ownerUserId="setup-owner" ownerName="Researcher" snapshot={null} device={null}
    cloudAvailable={false} localDeviceId={localDeviceId}
  />));
  await page.getByTestId('assistant-intro-primary').click();
  await expect.element(page.getByRole('textbox')).toBeVisible();
  const next = host.querySelector<HTMLButtonElement>('.ta-onb-actions button:last-child')!;
  await act(async () => next.click());
  expect(errors).toEqual([]);
  await expect.element(page.getByTestId(localDeviceId ? 'assistant-setup-home-computer' : 'assistant-setup-home-nocomputer')).toBeVisible();
  await expect.element(page.getByTestId('assistant-setup-home-cloud')).toBeVisible();
  expect(services.membership).toHaveBeenCalled();
});
