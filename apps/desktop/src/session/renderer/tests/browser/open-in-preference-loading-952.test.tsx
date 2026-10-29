import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { until } from '../../../../../../../tests/support/awaitCondition';
import { OPEN_IN_APPS } from '@shared/openInApps';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';

const mocks = vi.hoisted(() => ({
  preference: undefined as { default: 'finder' | 'terminal'; hidden: string[] } | undefined,
  openIn: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: mocks.preference, update: mocks.update }),
}));
vi.mock('@renderer/lib/hooks/useOpenInApps', () => ({
  useOpenInApps: () => ({
    icons: {},
    labels: { finder: 'Finder', terminal: 'Terminal' },
    installedApps: [OPEN_IN_APPS.finder, OPEN_IN_APPS.terminal],
    availability: { finder: true, terminal: true },
    loading: false,
  }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/hooks/useKeyboardShortcuts', () => ({
  getEffectiveHotkey: () => null,
  getHotkeyRegistration: () => '',
}));
vi.mock('@tanstack/react-hotkeys', () => ({ useHotkey: vi.fn() }));
vi.mock('@renderer/lib/ui/shortcut', () => ({ BoundShortcut: () => null }));
vi.mock('@renderer/app/recent-session-pages', async () => ({
  PageShownContext: (await import('react')).createContext(true),
}));
vi.mock('@renderer/app/screen-block-context', () => ({ useScreenBlock: () => ({ focused: true }) }));
vi.mock('@renderer/lib/commands/use-command-provider', () => ({ useCommandProvider: vi.fn() }));
vi.mock('@renderer/lib/commands/registry', () => ({ commandRegistry: { dispatch: vi.fn() } }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string) => key }),
}));
vi.mock('@renderer/lib/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => children,
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: () => null,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) => render ?? children,
}));
vi.mock('@gugu/session-ui/react/primitives', () => ({ useUiPortalContainer: () => undefined }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { app: { openIn: mocks.openIn } } }));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.preference = undefined;
  mocks.openIn.mockResolvedValue({ success: true });
  mocks.update.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function renderFileMenu() {
  root!.render(<OpenInMenu path="/fixture/README.md" />);
  await until('file Open In mounted', () => host!.querySelector('[data-slot="select-trigger"]') !== null);
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

async function expectFinderSelected() {
  await userEvent.click(host!.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')!);
  await until('Finder option visible', () => document.querySelector('[role="option"]') !== null);
  const finder = [...document.querySelectorAll('[role="option"]')]
    .find((element) => element.textContent?.includes('Finder'))!;
  expect(finder.getAttribute('aria-selected'), 'the file menu marks its default application').toBe('true');
  expect(mocks.openIn).not.toHaveBeenCalled();
  expect(mocks.update).not.toHaveBeenCalled();
}

it('marks the default when settings are already available before the file menu mounts', async () => {
  mocks.preference = { default: 'finder', hidden: [] };
  await renderFileMenu();
  await expectFinderSelected();
});

it('marks the default when the file menu is the first reader and settings arrive after mount', async () => {
  await renderFileMenu();
  mocks.preference = { default: 'finder', hidden: [] };
  await renderFileMenu();
  await expectFinderSelected();
});
