import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import JSZip from 'jszip'
import { describe, expect, it, vi } from 'vitest'
import {
  isExtensionBundle,
  summarizeExtensionBundle,
} from '../../../../apps/desktop/src/components/extensionBundle/summarizeExtensionBundle'

// Use the actual parser configured for a host at API 25; ZIP decoding and validation stay real.
vi.mock('@shared/extensions/bridge-protocol', async importOriginal => ({
  ...await importOriginal<typeof import('@shared/extensions/bridge-protocol')>(),
  EXTENSION_API_VERSION: 25,
}))

// #6646 聊天里的扩展卡片只读包里的 manifest.json。
const APP = '0.2.57'
const MANIFEST = {
  id: 'demo-share', name: 'Demo Share', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
}

async function zipOf(entries: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

describe('extension card summary (#6646)', () => {
  it('reads the manifest', async () => {
    const bytes = await zipOf({ 'manifest.json': JSON.stringify(MANIFEST), 'index.html': '<p>x</p>' })
    expect(await summarizeExtensionBundle(bytes, APP)).toEqual({
      ok: true,
      manifest: expect.objectContaining({ id: 'demo-share', name: 'Demo Share', version: '1.0.0' }),
    })
  })

  it('says what is wrong instead of drawing a card from a broken package', async () => {
    expect(await summarizeExtensionBundle(new TextEncoder().encode('not a zip'), APP)).toEqual({ ok: false, problem: 'not a zip archive' })
    expect(await summarizeExtensionBundle(await zipOf({ 'demo/manifest.json': '{}' }), APP))
      .toEqual({ ok: false, problem: 'no manifest.json at the top of the package' })
    expect(await summarizeExtensionBundle(await zipOf({ 'manifest.json': '{nope' }), APP))
      .toEqual({ ok: false, problem: 'manifest.json is not valid JSON' })
    const badId = await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify({ ...MANIFEST, id: 'has.dot' }) }), APP)
    expect(badId).toMatchObject({ ok: false, problem: expect.stringMatching(/^id: /) })
  })

  // 10-17 图标车道复核:给更新的咕咕做的包(它的 manifest 带着这一版不认识的字段,engines.gugu 高过这一版)——卡片说「去更新咕咕」,
  // 用市场那句话,❌「读不出来」。对照:engines 这一版满足、包照样读不出来的,不说更新。
  it('a package made for a newer gugu says which gugu it needs, not that it is unreadable', async () => {
    const newer = { ...MANIFEST, engines: { gugu: '>=0.2.58' }, contributes: { tabs: [{ name: 'main', title: 'Demo', laterField: true }] } }
    expect(await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify(newer) }), APP)).toMatchObject({ ok: false, compat: { reason: 'needs-newer-app', gate: 'app', minAppVersion: '0.2.58' } })
    expect(await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify(newer) }), '0.2.58-beta.3')).not.toHaveProperty('compat')
    expect(await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify({ ...newer, engines: { gugu: '>=0.2.50' } }) }), APP)).not.toHaveProperty('compat')
  })

  it('knows a package by its mime or, when a browser sent none, by its name', () => {
    expect(isExtensionBundle({ fileName: 'x.guguext', mimeType: 'application/vnd.gugu.extension+zip' })).toBe(true)
    expect(isExtensionBundle({ fileName: 'x.guguext', mimeType: 'application/octet-stream' })).toBe(true)
    expect(isExtensionBundle({ fileName: 'x.zip', mimeType: 'application/zip' })).toBe(false)
  })
})

it('A6 a real ZIP refused by the API25 parser carries API26 update guidance', async () => {
  const raw = { ...MANIFEST, apiVersion: 26, engines: { gugu: '>=0.3.1' } };
  const bytes = await zipOf({ 'manifest.json': JSON.stringify(raw), 'index.html': '<p>fixture</p>' });
  const result = await summarizeExtensionBundle(bytes, '0.3.1-beta.1133.1');
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('API25 parser unexpectedly accepted API26');
  expect(result.problem).toMatch(/apiVersion/);
  expect(result).toMatchObject({ compat: { reason: 'needs-newer-app', gate: 'api', apiVersion: 26, firstRelease: null } });
});

it('a too-old package asks its author, and a supported API still respects engines', async () => {
  const old = await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify({ ...MANIFEST, apiVersion: 24 }) }), '0.3.1');
  expect(old).toMatchObject({ ok: false, compat: { reason: 'needs-author-update', apiVersion: 24 } });
  const semver = await summarizeExtensionBundle(await zipOf({ 'manifest.json': JSON.stringify({ ...MANIFEST, engines: { gugu: '>=0.3.2' } }) }), '0.3.1');
  expect(semver).toMatchObject({ ok: false, compat: { reason: 'needs-newer-app', gate: 'app', minAppVersion: '0.3.2' } });
});
