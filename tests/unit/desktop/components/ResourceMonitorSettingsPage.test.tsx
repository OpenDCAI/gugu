// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createReactHarness } from '../../../support/testHarness';
import { ResourceMonitorSettingsPage } from '../../../../apps/desktop/src/session/renderer/features/settings/components/ResourceMonitorSettingsPage';

const monitor = vi.hoisted(() => ({ start: vi.fn(), dispose: vi.fn() }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { resourceMonitor: monitor } }));
vi.mock('@renderer/features/command-palette/resource-monitor-view', () => ({
  ResourceMonitorView: () => <div data-testid="live-resources" />,
}));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/features/settings/use-app-settings-key', async () => {
  const { useState } = await import('react');
  return {
    useAppSettingsKey: () => {
      const [enabled, setEnabled] = useState(false);
      return {
        value: { enabled }, isLoading: false, isSaving: false,
        update: (next: { enabled: boolean }) => setEnabled(next.enabled),
      };
    },
  };
});

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => { vi.clearAllMocks(); harness = createReactHarness(); });
afterEach(() => harness.cleanup());
const toggle = async () => {
  const button = harness.container.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(button).not.toBeNull();
  await act(async () => button!.click());
};

it('shows the page without starting monitoring until the user enables it, then stops when disabled', async () => {
  await harness.render(<ResourceMonitorSettingsPage />);
  expect(harness.container.textContent).toContain('resourceMonitor.off');
  expect(harness.container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  expect(harness.container.querySelector('[data-testid="live-resources"]')).toBeNull();
  expect(monitor.start).not.toHaveBeenCalled();
  await toggle();
  expect(monitor.start).toHaveBeenCalledTimes(1);
  expect(harness.container.querySelector('[data-testid="live-resources"]')).not.toBeNull();
  await toggle();
  expect(monitor.dispose).toHaveBeenCalledTimes(1);
  expect(harness.container.querySelector('[data-testid="live-resources"]')).toBeNull();
});

it('stops sampling when the user leaves the enabled page', async () => {
  await harness.render(<ResourceMonitorSettingsPage />);
  await toggle();
  expect(monitor.start).toHaveBeenCalledTimes(1);
  await harness.render(<div>another settings page</div>);
  expect(monitor.dispose).toHaveBeenCalledTimes(1);
});
