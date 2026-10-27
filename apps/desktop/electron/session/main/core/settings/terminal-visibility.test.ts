import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('./settings-service', () => ({ appSettingsService: {} }));

const { migratedTerminalEnabled } = await import('./terminal-visibility');

describe('migratedTerminalEnabled', () => {
  it('turns the terminal on for someone who last picked the coding view by hand', () => {
    expect(migratedTerminalEnabled({ lastPickedView: 'code', hasOpenedShellTerminal: false })).toBe(true);
  });

  it('turns the terminal on for someone who has opened a shell terminal tab', () => {
    expect(migratedTerminalEnabled({ lastPickedView: 'general', hasOpenedShellTerminal: true })).toBe(true);
  });

  it('keeps the terminal off for everyone else, new installs included', () => {
    expect(migratedTerminalEnabled({ lastPickedView: 'general', hasOpenedShellTerminal: false })).toBe(false);
  });
});
