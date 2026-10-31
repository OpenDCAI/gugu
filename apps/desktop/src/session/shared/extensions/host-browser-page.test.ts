import { describe, expect, it } from 'vitest';
import { safeParseExtensionManifest } from './manifest';

const manifest = (tab: Record<string, unknown>) => ({
  id: 'browser-use', name: 'Browser Use', version: '1.0.0', apiVersion: 5,
  permissions: { capabilities: ['agents:tools'] },
  contributes: { tabs: [tab], mcpServers: [{ name: 'browser-use', host: 'browser-use' }] },
});

describe('App pages after removing the host browser page', () => {
  it('refuses the removed host page even with the former native program and per-session flag', () => {
    expect(safeParseExtensionManifest(manifest({ name: 'browser', title: 'Browser', hostPage: 'browser', perSession: true })).ok).toBe(false);
  });

  it('keeps host settings and App-owned per-session HTML pages', () => {
    expect(safeParseExtensionManifest(manifest({ name: 'settings', title: 'Settings', hostPage: 'settings' })).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest({ name: 'main', title: 'Browser', entry: 'browser.html', perSession: true })).ok).toBe(true);
  });
});
