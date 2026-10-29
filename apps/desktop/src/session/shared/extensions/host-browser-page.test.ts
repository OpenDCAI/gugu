import { describe, expect, it } from 'vitest';
import { safeParseExtensionManifest } from './manifest';

// owner 10-28:看 / 接管 agent 浏览器的地方 = Browser Use App 的每任务一份页签(`hostPage: 'browser'`),由宿主画。
const manifest = (tab: Record<string, unknown>, servers: unknown[] = [{ name: 'browser-use', host: 'browser-use' }]) => ({
  id: 'browser-use',
  name: 'Browser Use',
  version: '1.0.0',
  apiVersion: 5,
  permissions: { capabilities: ['agents:tools'] },
  contributes: { tabs: [{ name: 'settings', title: 'Settings', hostPage: 'settings' }, tab], mcpServers: servers },
});
const browser = { name: 'browser', title: 'Browser', hostPage: 'browser', perSession: true };
const issues = (raw: unknown) => {
  const parsed = safeParseExtensionManifest(raw);
  return parsed.ok ? [] : parsed.issues.join('\n');
};

describe('host browser page (hostPage: "browser")', () => {
  it('accepts a per-task browser page beside the settings page of a browser-use App', () => {
    const parsed = safeParseExtensionManifest(manifest(browser));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest.contributes.tabs[1]).toMatchObject({ hostPage: 'browser', perSession: true });
  });

  it('refuses one that is not one per task', () => {
    expect(issues(manifest({ ...browser, perSession: undefined }))).toMatch(/host browser page shows one task's browser: it needs "perSession": true/);
  });

  it('refuses entry, opensFiles and page commands on it, naming the page', () => {
    expect(issues(manifest({ ...browser, entry: 'app/browser.html' }))).toMatch(/a host browser page cannot have entry, opensFiles or page commands/);
    expect(issues(manifest({ ...browser, opensFiles: { session: ['.html'] } }))).toMatch(/a host browser page cannot have entry/);
    expect(issues(manifest({ ...browser, menu: [{ id: 'go', title: 'Go' }] }))).toMatch(/a host browser page cannot have entry/);
  });

  it('refuses it in an App without a browser-use host program', () => {
    expect(issues(manifest(browser, [{ name: 'computer-use', host: 'computer-use' }]))).toMatch(/needs a "browser-use" host program/);
  });

  it('keeps the settings page one per App, and an unknown host page refused', () => {
    expect(issues(manifest({ name: 'own', title: 'Own', hostPage: 'settings', perSession: true }))).toMatch(/a page per task cannot be the host settings page/);
    expect(safeParseExtensionManifest(manifest({ ...browser, hostPage: 'terminal' })).ok).toBe(false);
  });
});
