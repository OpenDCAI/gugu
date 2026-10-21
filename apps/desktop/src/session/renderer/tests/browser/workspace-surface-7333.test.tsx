import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { NAV_COLUMN_WIDTH } from '@/lib/uiRuler';
import { WorkspaceLayout, WorkspaceContentLayout } from '@renderer/lib/layout/workspace-layout';
import { WorkspaceLayoutContextProvider, useWorkspaceLayoutContext } from '@renderer/lib/layout/layout-provider';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { TitlebarActions } from '@renderer/features/sessions/titlebar-actions';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import '@/styles/tokens.css';
import '@/components/sessionpage/EmdashSessionFrame.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
// The shell toggle publishes host IPC; this case exercises the actual layout/context instead.
vi.mock('@renderer/lib/components/titlebar/shell-titlebar', async (original) => ({ ...(await original<object>()), ShellSidebarToggle: () => null }));

let harness: ReturnType<typeof createReactHarness>;
const mounted = vi.fn();
function Body() {
  useEffect(() => { mounted(); }, []);
  const { toggleLeft } = useWorkspaceLayoutContext();
  return <><input aria-label="retained draft" defaultValue="keep this draft" /><button onClick={toggleLeft}>toggle list</button></>;
}
beforeEach(async () => {
  await page.viewport(1000, 700);
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
  document.documentElement.dataset.platform = 'mac';
  document.documentElement.dataset.theme = 'light';
  document.documentElement.dataset.windowMaterial = 'native';
  mounted.mockClear();
});
afterEach(() => {
  harness?.cleanup();
  delete document.documentElement.dataset.platform;
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.windowMaterial;
});

it('the real workspace keeps an opaque rounded reading surface inset from material, with fixed and local chrome aligned through collapse', async () => {
  harness = createReactHarness();
  await harness.render(
    <div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
      <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
        <WorkspaceLayout
          leftSidebar={<div>project list</div>}
          mainContent={<WorkspaceContentLayout
            titlebarSlot={<ShellTitlebar leftSlot={<button aria-label="project menu" style={{ height: 28 }}>project</button>}>
              <TitlebarActions actions={{ 'workspace-panel': <button aria-label="workspace panel">panel</button> }} />
            </ShellTitlebar>}
            mainPanel={<Body />}
          />}
        />
      </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
    </div>
  );
  const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
  const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
  expect(shell).not.toBeNull();
  expect(shell.querySelector('aside')!.getBoundingClientRect().width).toBe(NAV_COLUMN_WIDTH);
  expect(surface).not.toBeNull();
  const rect = surface.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(700);
  expect(rect.top - shell.getBoundingClientRect().top).toBeCloseTo(5);
  expect(shell.getBoundingClientRect().right - rect.right).toBeCloseTo(5);
  expect(shell.getBoundingClientRect().bottom - rect.bottom).toBeCloseTo(5);
  const style = getComputedStyle(surface);
  expect(style.borderRadius).toBe('12px');
  expect(style.backgroundColor).toBe('rgb(255, 255, 255)');
  expect(style.boxShadow).not.toBe('none');
  expect(shell.querySelector('aside > .bg-border'), 'no full-height line may protrude into the rounded frame gutter').toBeNull();
  const local = harness.container.querySelector<HTMLElement>('[aria-label="project menu"]')!;
  const fixed = harness.container.querySelector<HTMLElement>('[data-titlebar-action-slot]')!;
  const center = (element: HTMLElement) => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
  expect(center(fixed)).toBeCloseTo(center(local));
  const draft = harness.container.querySelector<HTMLInputElement>('[aria-label="retained draft"]')!;
  await userEvent.click([...harness.container.querySelectorAll('button')].find((button) => button.textContent === 'toggle list')!);
  await until('the real list collapse completes', () => shell.querySelector('aside')!.getBoundingClientRect().width < 0.5);
  expect(harness.container.querySelector('[aria-label="retained draft"]')).toBe(draft);
  expect(draft.value).toBe('keep this draft');
  expect(mounted).toHaveBeenCalledTimes(1);
  expect(surface.getBoundingClientRect().top - shell.getBoundingClientRect().top).toBeCloseTo(5);
  expect(center(fixed)).toBeCloseTo(center(local));
});

for (const material of ['native', 'opaque']) {
  it(`full-width embedded pages expose the ${material} shell outside their rounded surface`, async () => {
    document.documentElement.dataset.windowMaterial = material;
    harness = createReactHarness();
    await harness.render(<div data-desktop-shell="" style={{ position: 'fixed', inset: 0 }}>
      <div className="gg-session-frame"><div className="gg-session-frame-host"><div className="gugu-skin emlight">
        <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
          <WorkspaceLayout sidebarHidden leftSidebar={<div>retained list</div>} mainContent={<WorkspaceContentLayout titlebarSlot={null} mainPanel={<div>full-width page</div>} />} />
        </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
      </div></div></div>
    </div>);
    const frame = harness.container.querySelector<HTMLElement>('.gg-session-frame')!;
    const skin = harness.container.querySelector<HTMLElement>('.gugu-skin')!;
    for (const element of [frame, skin]) {
      const color = getComputedStyle(element).backgroundColor;
      if (material === 'native') expect(color).toBe('rgba(0, 0, 0, 0)');
      else expect(color).not.toBe('rgba(0, 0, 0, 0)');
    }
    expect(harness.container.querySelector<HTMLElement>('[data-workspace-left-panel]')!.getBoundingClientRect().width).toBe(0);
    const shell = harness.container.querySelector<HTMLElement>('[data-workspace-shell]')!;
    const surface = harness.container.querySelector<HTMLElement>('[data-workspace-content-surface]')!;
    expect(surface.getBoundingClientRect().width).toBeGreaterThan(900);
    expect(surface.getBoundingClientRect().top - shell.getBoundingClientRect().top).toBe(5);
  });
}

it('a saved user sidebar width takes precedence over the unified navigation default', async () => {
  localStorage.setItem('gugu.taskpage.sidebarWidth', '320');
  harness = createReactHarness();
  await harness.render(<div className="gugu-skin emlight" style={{ position: 'fixed', inset: 0 }}>
    <SessionLocalizationProvider><WorkspaceLayoutContextProvider>
      <WorkspaceLayout leftSidebar={<div>project list</div>} mainContent={<div>content</div>} />
    </WorkspaceLayoutContextProvider></SessionLocalizationProvider>
  </div>);
  const aside = harness.container.querySelector('aside')!;
  expect(aside.getBoundingClientRect().width).toBe(320);
  expect(localStorage.getItem('gugu.taskpage.sidebarWidth')).toBe('320');
  localStorage.removeItem('gugu.taskpage.sidebarWidth');
});
