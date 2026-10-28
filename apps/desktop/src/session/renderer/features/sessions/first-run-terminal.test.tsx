// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { FirstRunTerminal } from '@/components/firstRun/FirstRunTerminal';

const f = vi.hoisted(() => ({ enabled: false, update: vi.fn(), done: vi.fn(), back: vi.fn(), seen: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/features/settings/use-terminal-enabled', () => ({ useTerminalEnabled: () => f.enabled }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ update: f.update }) }));
vi.mock('@/lib/firstRun', () => ({ writeFirstRunTerminalSeen: f.seen }));

let host: HTMLDivElement; let root: Root;
const render = () => act(async () => root.render(<FirstRunTerminal userId="qa-user" onBack={f.back} onDone={f.done} />));
const toggle = () => host.querySelector<HTMLElement>('[role="switch"]')!;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  f.enabled = false; f.update.mockReset(); f.done.mockReset(); f.back.mockReset(); f.seen.mockReset().mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('first-run session terminal step (owner 10-27)', () => {
  it('is one page: a title, one line, the film, the switch off on a new install, and Continue', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toBe('firstRun.terminalTitle');
    expect(host.querySelectorAll('p')).toHaveLength(1);
    expect(host.querySelector('[data-testid="first-run-terminal-film-toggle"]')).not.toBeNull();
    const film = host.querySelector<HTMLVideoElement>('[data-testid="first-run-terminal-film"]')!;
    expect(film.muted && film.loop && film.autoplay).toBe(true);
    expect(host.querySelectorAll('[role="switch"]')).toHaveLength(1);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(host.querySelectorAll('ul, li')).toHaveLength(0);
  });
  it('writes the same setting as Settings → General → Terminal, remembers the page was seen, and goes back', async () => {
    await render();
    await act(async () => toggle().click());
    expect(f.update).toHaveBeenCalledWith({ enabled: true });
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="first-run-terminal-continue"]')!.click());
    expect(f.seen).toHaveBeenCalledWith('qa-user');
    expect(f.done).toHaveBeenCalledOnce();
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="first-run-terminal-back"]')!.click());
    expect(f.back).toHaveBeenCalledOnce();
  });
  it('reflects a switch that is already on', async () => {
    f.enabled = true;
    await render();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });
});
