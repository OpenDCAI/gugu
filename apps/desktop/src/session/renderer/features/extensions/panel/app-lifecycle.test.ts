import { describe, expect, it } from 'vitest';
import { appLifecycle } from './app-lifecycle';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import type { MarketListItem } from '@shared/extensions/market';
import type { SessionTranslate } from '../extension-consent';

const installed: ExtensionManifest = { id: 'notes', name: 'Notes', version: '1.0.0', apiVersion: 24, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Notes' }] } };
const offered = { manifest: { ...installed, version: '2.0.0' }, cloud: { compat: null } } as MarketListItem;
const translate: SessionTranslate = (key) => key;
const base = { enabled: true, preinstalled: false, canOpen: true, offered };

describe('the lifecycle shared by desktop and phone App pages', () => {
  it('installs, updates, then opens the same App', () => {
    expect(appLifecycle(base, translate)).toEqual({ kind: 'get' });
    expect(appLifecycle({ ...base, installed }, translate)).toEqual({ kind: 'update', version: '2.0.0' });
    expect(appLifecycle({ ...base, installed: offered.manifest }, translate)).toEqual({ kind: 'open' });
  });
  it('enables a stopped App before offering its update and respects preinstalled ownership', () => {
    expect(appLifecycle({ ...base, installed, enabled: false, updateVersion: '3.0.0' }, translate)).toEqual({ kind: 'enable' });
    expect(appLifecycle({ ...base, installed, preinstalled: true }, translate)).toEqual({ kind: 'open' });
    expect(appLifecycle({ ...base, installed, preinstalled: true, canOpen: false }, translate)).toEqual({ kind: 'word', text: 'extensions.installedMark' });
  });
  it('reports compatibility instead of offering an install and keeps pinned updates actionable', () => {
    expect(appLifecycle({ ...base, offered: { ...offered, cloud: { ...offered.cloud, compat: { reason: 'needs-author-update', apiVersion: 1 } } } }, translate)?.kind).toBe('word');
    expect(appLifecycle({ ...base, installed, updateVersion: '3.0.0' }, translate)).toEqual({ kind: 'update', version: '3.0.0' });
  });
});
