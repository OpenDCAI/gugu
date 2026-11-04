import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { MAX_BUNDLE_ENTRIES } from '@shared/extensions/market';
import { ExtensionsService } from './extensions-service';
import { validateExtensionBundle } from './extension-validate';

const EXAMPLES = fileURLToPath(new URL('../../../../../../../examples/extensions/', import.meta.url));

let workDir: string;
let service: ExtensionsService;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'gugu-ext-validate-'));
  service = new ExtensionsService(path.join(workDir, 'installed'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function bundle(name: string, patch: Record<string, unknown> = {}, files: Record<string, string> = {}): string {
  const dir = path.join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id: 'demo-ext',
    name: 'Demo',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    platforms: ['desktop'],
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
    ...patch,
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [file, content] of Object.entries({ 'index.html': '<!doctype html>', ...files })) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe('validateExtensionBundle', () => {
  it('passes the shipped examples, tab-only and declaring alike', () => {
    for (const example of ['regex-forge', 'ext-debug', 'cache-keeper']) {
      const report = validateExtensionBundle(service, path.join(EXAMPLES, example));
      expect(report).toMatchObject({ ok: true, problems: [] });
      expect(report.inspected?.manifest.id).toBe(example);
    }
  });

  it('reports every schema problem when the manifest does not parse', () => {
    const report = validateExtensionBundle(service, bundle('bad-schema', { id: 'has.dot', entry: '../outside.html' }));
    expect(report.ok).toBe(false);
    expect(report.inspected).toBeNull();
    expect(report.problems.some((problem) => problem.startsWith('id: '))).toBe(true);
    expect(report.problems.some((problem) => problem.startsWith('entry: must be a bundle-relative path'))).toBe(true);
  });

  it('refuses a symbolic link anywhere in the bundle, and says so twice when it carries the entry out', () => {
    writeFileSync(path.join(workDir, 'secret.txt'), 'key');
    const leaking = bundle('leaking');
    symlinkSync(path.join(workDir, 'secret.txt'), path.join(leaking, 'notes.txt'));
    const leaked = validateExtensionBundle(service, leaking);
    expect(leaked).toMatchObject({ ok: false, problems: ['symbolic link: notes.txt'] });

    const escaping = path.join(workDir, 'escaping');
    mkdirSync(escaping);
    writeFileSync(path.join(escaping, 'manifest.json'), JSON.stringify({
      id: 'demo-ext', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Demo' }] },
    }));
    symlinkSync(path.join(workDir, 'secret.txt'), path.join(escaping, 'index.html'));
    const escaped = validateExtensionBundle(service, escaping);
    expect(escaped.ok).toBe(false);
    expect(escaped.problems).toEqual(['entry path escapes the bundle: entry', 'symbolic link: index.html']);
  });

  it('counts files against the market limit, skipping what packing skips', () => {
    const dir = bundle('crowded');
    mkdirSync(path.join(dir, 'node_modules'));
    for (let index = 0; index < MAX_BUNDLE_ENTRIES; index += 1) {
      writeFileSync(path.join(dir, 'node_modules', `${index}.js`), '');
    }
    expect(validateExtensionBundle(service, dir)).toMatchObject({ ok: true, problems: [] });

    mkdirSync(path.join(dir, 'assets'));
    for (let index = 0; index < MAX_BUNDLE_ENTRIES; index += 1) {
      writeFileSync(path.join(dir, 'assets', `${index}.js`), '');
    }
    expect(validateExtensionBundle(service, dir).problems).toEqual([
      `too many files: ${MAX_BUNDLE_ENTRIES + 2} > ${MAX_BUNDLE_ENTRIES}`,
    ]);
  });

  it('reports a path that is not a directory instead of throwing', () => {
    const report = validateExtensionBundle(service, path.join(workDir, 'missing'));
    expect(report).toMatchObject({ ok: false, inspected: null });
    expect(report.problems).toEqual([`App source is not a directory: ${path.join(workDir, 'missing')}`]);
  });
});
