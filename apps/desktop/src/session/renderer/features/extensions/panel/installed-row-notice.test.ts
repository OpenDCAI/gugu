import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { consentPrompt } from '../extension-consent';

vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: {} }, events: { on: () => () => {} } }));
// The row's 「给哪些 agent」 section reaches the window-bound platform layer; the notice line does not use it.
vi.mock('./app-given-section', () => ({ AppGivenSection: () => null }));

const { InstalledRowNoticeLine } = await import('./installed-extension-row');

/**
 * The installed version withdrawn, the market offers another: the link says which way it goes. Going back to an older one
 * is no update (A/B 10-08: withdrawn 0.1.3 offered 「Update to v0.1.2」), and neither is the sheet's button that confirms it.
 */
const translate = ((key: string, params?: Record<string, string>) =>
  params ? `${key}(${Object.values(params).join('|')})` : key) as never;

function line(installedVersion: string, installable: string): string {
  return renderToStaticMarkup(
    React.createElement(InstalledRowNoticeLine, {
      notice: { kind: 'yanked', reason: 'bad', installable },
      installedVersion,
      translate,
      onInstallVersion: () => {},
      onBrowseReplacement: () => {},
    })
  );
}

const probe = (version: string) =>
  parseExtensionManifest({
    id: 'probe', name: 'Probe', version, apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Probe' }] },
  });

describe('a withdrawn version, and the version offered instead', () => {
  it('older: 「Use v0.1.2 instead」; newer: 「Update to v0.2.0」', () => {
    expect(line('0.1.3', '0.1.2')).toContain('extensions.useVersion(0.1.2)');
    expect(line('0.1.3', '0.1.2')).not.toContain('extensions.updateTo');
    expect(line('0.1.3', '0.2.0')).toContain('extensions.updateTo(0.2.0)');
  });

  it("the sheet that confirms it: going back, its button says the version; going forward, 「Update」", () => {
    expect(consentPrompt(probe('0.1.3'), [], probe('0.1.2'), translate, 'en-US').confirmLabel).toBe('extensions.useVersion(0.1.2)');
    expect(consentPrompt(probe('0.1.3'), [], probe('0.1.2'), translate, 'en-US').title).toContain('extensions.downgradeConfirmTitle');
    expect(consentPrompt(probe('0.1.2'), [], probe('0.1.3'), translate, 'en-US').confirmLabel).toBe('extensions.updateAction');
  });
});
