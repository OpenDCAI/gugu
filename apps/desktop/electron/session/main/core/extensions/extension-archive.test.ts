import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { packExtensionArchive, packInstalledExtension, unpackExtensionArchive } from './extension-archive';
import { ExtensionsService } from './extensions-service';

let workDir: string;
let service: ExtensionsService;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'gugu-guguext-'));
  service = new ExtensionsService(path.join(workDir, 'installed'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const MANIFEST = {
  id: 'demo-ext', name: 'Demo', version: '1.2.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  platforms: ['desktop'],
  entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
};

function bundle(name: string, files: Record<string, string | Buffer> = {}, manifest: object = MANIFEST): string {
  const dir = path.join(workDir, name);
  for (const [file, content] of Object.entries({ 'manifest.json': JSON.stringify(manifest), 'index.html': '<!doctype html>', ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

function listed(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listed(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  ).sort();
}

async function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('.guguext packing (#6646)', () => {
  it('packs the same files to the same bytes, skipping what the market skips, and unpacks them back checked', async () => {
    const dir = bundle('demo', { 'app.js': 'console.log(1)', 'node_modules/left-pad/index.js': 'x' });
    // Packed under two different clocks: zip stores times, and the fingerprint must not.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = await packExtensionArchive(service, dir);
    vi.setSystemTime(new Date('2026-06-01T12:34:56Z'));
    const second = await packExtensionArchive(service, dir);
    vi.useRealTimers();
    expect(second.sha256).toBe(first.sha256);
    expect(first.manifest).toMatchObject({ id: 'demo-ext', version: '1.2.0' });

    const staging = path.join(workDir, 'staging');
    const unpacked = await unpackExtensionArchive(service, first.bytes, staging);
    expect(unpacked.sha256).toBe(first.sha256);
    expect(unpacked.report).toMatchObject({ ok: true, problems: [] });
    expect(listed(unpacked.dir)).toEqual(['app.js', 'index.html', 'manifest.json']);
    expect(readFileSync(path.join(unpacked.dir, 'app.js'), 'utf8')).toBe('console.log(1)');
  });

  // App 模型 v2 (owner 10-31): the top-level store/ is the market listing, never part of the App; a store/ deeper in is the App's.
  it('leaves the top-level store/ out of the package, and keeps one deeper in', async () => {
    const dir = bundle('listed', { 'index.html': '<p>hi</p>', 'store/about.md': 'About.', 'store/screenshots/1.png': 'png', 'lib/store/state.js': 'export {}' });
    const packed = await packExtensionArchive(service, dir);
    const unpacked = await unpackExtensionArchive(service, packed.bytes, path.join(workDir, 'listed-out'));
    expect(listed(unpacked.dir)).toEqual(['index.html', 'lib/store/state.js', 'manifest.json']);
  });

  it('packs the market fixture to the published packDir fingerprint', async () => {
    const dir = path.resolve('tests/fixtures/extensions/market-pack');
    // Recompute in shuxueshuxue/gugu-apps at 3779955c (scripts/lib.mjs packDir):
    // LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 node --input-type=module -e 'import {packDir,sha256} from "./scripts/lib.mjs"; console.log(sha256(await packDir(process.argv[1])))' /path/to/gugu/tests/fixtures/extensions/market-pack
    // Nested, mixed-case and Chinese names distinguish directory entries, recursive order and locale sorting.
    const packed = await packExtensionArchive(service, dir);
    expect(packed.sha256).toBe('21c62f91d7c868a5fd832fa0f6045a59288b463bd7d9c9cc0d97a4251f1f62f1');
    service.installFromDirectory(dir, service.inspectDirectory(dir).manifestDigest, 'folder');
    expect((await packInstalledExtension(service, 'market-pack')).bytes).toEqual(packed.bytes);
  });

  it('refuses to pack a bundle the package checks refuse, saying why', async () => {
    const dir = bundle('linked');
    writeFileSync(path.join(workDir, 'secret.txt'), 'key');
    symlinkSync(path.join(workDir, 'secret.txt'), path.join(dir, 'notes.txt'));
    await expect(packExtensionArchive(service, dir)).rejects.toThrow('symbolic link: notes.txt');
  });

  it('refuses a package that escapes its folder or does not validate, and leaves nothing behind', async () => {
    const staging = path.join(workDir, 'staging');
    const escaping = await zipOf({ 'manifest.json': JSON.stringify(MANIFEST), 'index.html': '', '../outside.txt': 'x' });
    // JSZip itself rewrites `../x` to `/x`; either way the market unpacker refuses the whole package.
    await expect(unpackExtensionArchive(service, escaping, staging)).rejects.toThrow('Refusing to unpack this bundle');

    const badSchema = await zipOf({ 'manifest.json': JSON.stringify({ ...MANIFEST, id: 'has.dot' }), 'index.html': '' });
    await expect(unpackExtensionArchive(service, badSchema, staging)).rejects.toThrow(/problems:\n- id: /);

    const noManifest = await zipOf({ 'demo/manifest.json': JSON.stringify(MANIFEST), 'demo/index.html': '' });
    await expect(unpackExtensionArchive(service, noManifest, staging)).rejects.toThrow('Missing manifest.json');

    expect(readdirSync(staging)).toEqual([]);
    expect(readdirSync(workDir).includes('outside.txt')).toBe(false);
  });
});
