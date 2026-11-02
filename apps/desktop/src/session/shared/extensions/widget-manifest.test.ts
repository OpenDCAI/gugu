import { describe, expect, it } from 'vitest';
import { safeParseExtensionManifest } from './manifest';

const app = (tab: object, apiVersion = 26) => ({ id: 'board', name: 'Board', version: '1.0.0', apiVersion, defaultLocale: 'en', entry: 'main.html', contributes: { tabs: [{ name: 'main', title: 'Board', ...tab }] } });
describe('message views', () => {
  it('accepts fixed heights and leaves API25 tabs valid', () => {
    for (const height of [64, 240, 520]) expect(safeParseExtensionManifest(app({ widget: { height } })).ok).toBe(true);
    expect(safeParseExtensionManifest(app({}, 25)).ok).toBe(true);
    expect(safeParseExtensionManifest(app({ widget: { height: 240 } }, 25)).ok).toBe(false);
  });
  it.each([63, 521, 100.5])('rejects invalid height %s', height => {
    expect(safeParseExtensionManifest(app({ widget: { height } })).ok).toBe(false);
  });
  it.each([{ hostPage: 'settings' }, { perSession: true }, { opensFiles: { chat: ['.json'] } }, { chatFile: 'board.json' }])('rejects conflicting places %s', other => {
    expect(safeParseExtensionManifest(app({ ...other, widget: { height: 240 } })).ok).toBe(false);
  });
  it('lets the App tell agents how to send its widget without giving programs', () => {
    const input = app({ widget: { height: 240 } });
    expect(safeParseExtensionManifest({ ...input, contributes: { ...input.contributes, instructions: 'Send results with widget_send.' } }).ok).toBe(true);
  });
});
