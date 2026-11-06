import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import type { HostDependencyInstallation } from '@renderer/lib/stores/use-agent-installation-statuses';
import type { Installation } from '@shared/core/agents/agent-payload';
import { AgentSourceList } from './AgentSourceList';

let dom: JSDOM, root: Root, container: HTMLDivElement;
beforeEach(() => {
  dom = new JSDOM('<div id="root"></div>');
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'Event',
    'CustomEvent',
    'MutationObserver'
  ] as const)
    vi.stubGlobal(key, dom.window[key]);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(cb, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  container = document.getElementById('root') as HTMLDivElement;
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  dom.window.close();
});
const program: Installation = {
  id: '/bin/test-engine',
  realpath: '/bin/test-engine',
  pathEntry: '/bin/test-engine',
  isActive: true,
  manageable: false,
  provenance: { kind: 'homebrew', confidence: 'confirmed' },
  status: 'available',
  version: '0.160.0',
  latestVersion: '0.167.0',
  updateAvailable: true
};
function vm(overrides: Partial<HostDependencyInstallation> = {}): HostDependencyInstallation {
  return {
    data: null,
    installations: [],
    used: undefined,
    installProgress: null,
    cancelInstall: vi.fn(async () => true),
    status: 'missing',
    isInstalling: false,
    isUpdating: false,
    isUninstalling: false,
    lastInstallError: null,
    lastUpdateError: null,
    lastInstallSucceededAt: null,
    installingMethod: undefined,
    installingRegistry: undefined,
    updatingMethod: undefined,
    uninstallingMethod: undefined,
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    setUsed: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    fetchLatestVersion: vi.fn(async () => {}),
    probeOverride: vi.fn(async () => null),
    ...overrides
  };
}
async function render(model = vm(), local?: Installation, onUpdate?: () => void) {
  const install = vi.fn();
  await act(async () =>
    root.render(
      <SessionLocalizationProvider>
        <AgentSourceList
          vm={model}
          agentPayload={undefined}
          inUse={local ? 'local' : null}
          local={local}
          managed={undefined}
          custom={undefined}
          canInstall
          canUninstall={false}
          onSelect={vi.fn()}
          onInstall={install}
          onUpdate={onUpdate}
          onOpenCustom={vi.fn()}
          customEditor={undefined}
        />
      </SessionLocalizationProvider>
    )
  );
  return install;
}
function button(label: string) {
  return [...container.querySelectorAll('button')].find((el) => el.textContent === label)!;
}
it('offers installation first, with a managed default and no source radio circles', async () => {
  const install = await render();
  expect(container.querySelector('.gg-settings-row-title')?.textContent).toBe('Installation');
  expect(container.querySelector('[role="combobox"]')?.textContent).toContain('Managed by Gugu');
  expect(container.querySelector('[role="radio"]')).toBeNull();
  expect(
    [...container.querySelectorAll('.gg-settings-row-title')].map((el) => el.textContent)
  ).toEqual(['Installation', 'Source']);
  await act(async () => button('Install').click());
  expect(install).toHaveBeenCalledOnce();
});
it('keeps progress and cancellation on the installation row and removes source selection while busy', async () => {
  const model = vm({
    isInstalling: true,
    installProgress: {
      providerId: 'codex',
      phase: 'downloading',
      bytesDone: 38,
      bytesTotal: 100,
      elapsedMs: 1000
    }
  });
  await render(model);
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.querySelector('[data-testid="install-progress-determinate"]')).not.toBeNull();
  await act(async () => button('Cancel').click());
  expect(model.cancelInstall).toHaveBeenCalledOnce();
  expect(button('Cancel').disabled).toBe(true);
});
it('keeps an installation failure inline, with its existing diagnostic folded', async () => {
  await render(
    vm({ lastInstallError: { message: 'Download was interrupted', diagnostic: 'ECONNRESET' } })
  );
  expect(container.querySelector('[data-testid="agent-installation-row"]')?.textContent).toContain(
    'The download connection was interrupted'
  );
  expect(container.querySelector('.text-foreground-destructive')?.textContent).not.toContain('ECONNRESET');
  expect(container.querySelector('details')?.textContent).toContain('ECONNRESET');
  expect(container.querySelector('details')?.open).toBe(false);
  expect(button('Reinstall')).toBeDefined();
  expect(container.textContent).not.toContain('Retry');
});
it('shows both versions and installs a managed copy instead of updating a user-owned binary', async () => {
  const model = vm({ status: 'available', installations: [program] });
  const install = await render(model, program);
  const row = container.querySelector('[data-testid="agent-installation-row"]');
  expect(row?.textContent).toContain('0.160.0');
  expect(row?.textContent).toContain('0.167.0');
  await act(async () => button('Install and switch').click());
  expect(install).toHaveBeenCalledOnce();
  expect(model.update).not.toHaveBeenCalled();
  expect(model.uninstall).not.toHaveBeenCalled();
});

it('repairs the displayed installation failure when an older update failure also exists', async () => {
  const update = vi.fn();
  const install = await render(vm({ lastInstallError: { message: 'Installation failed', diagnostic: null }, lastUpdateError: { message: 'Old update failure', diagnostic: null } }), undefined, update);
  await act(async () => button('Reinstall').click());
  expect(install).toHaveBeenCalledOnce();
  expect(update).not.toHaveBeenCalled();
});
it('does not label a missing recorded binary as a failed-to-start binary', async () => {
  await render(vm(), { ...program, status: 'missing', version: null });
  expect(container.querySelector('[data-testid="agent-installation-row"]')?.textContent).toContain('Not installed');
  expect(container.textContent).not.toContain('Fails to start');
});
