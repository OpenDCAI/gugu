import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nowhere', getPath: () => '/nowhere' } }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const { ExtensionsService } = await import('./extensions-service');
const { ensurePreinstalledApps } = await import('./preinstalled-apps');
const { log } = await import('@main/lib/logger');

/**
 * Preinstalled Apps (L3): gugu installs what it shipped, every start, and nothing takes them away.
 * Judged against a real ExtensionsService on temp directories.
 */

function bundle(dir: string, id: string, version: string, capabilities: string[] = ['files:read', 'files:write']) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id,
      name: id,
      author: 'gugu official',
      version,
      apiVersion: EXTENSION_API_VERSION,
      entry: 'index.html',
      permissions: { capabilities },
      contributes: { tabs: [{ name: 'main', title: id }] },
    }),
  );
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html><p>${id} ${version}</p>`);
}

let root: string;
let shipped: string;
let service: InstanceType<typeof ExtensionsService>;
beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), 'gugu-preinstalled-'));
  root = path.join(base, 'task-extensions');
  shipped = path.join(base, 'preinstalled-apps');
  service = new ExtensionsService(root);
});

describe('preinstalled Apps', () => {
  it('installs what gugu shipped, as `preinstalled`, switched on, with its declared capabilities', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    const report = ensurePreinstalledApps(service, shipped);
    expect(report).toEqual({ installed: ['workspace'], failed: [], missing: null, released: [] });
    expect(service.origins().workspace).toBe('preinstalled');
    expect(service.isEnabled('workspace')).toBe(true);
    expect(service.grantedCapabilities('workspace')).toEqual(['files:read', 'files:write']);
  });

  it('every start installs the shipped bytes again — an update of gugu is an update of its Apps', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    ensurePreinstalledApps(service, shipped);
    writeFileSync(path.join(shipped, 'workspace', 'index.html'), '<!doctype html><p>new code, same version</p>');
    ensurePreinstalledApps(service, shipped);
    expect(readFileSync(path.join(root, 'workspace', 'index.html'), 'utf8')).toContain('new code');
  });

  it('cannot be uninstalled, switched off, or replaced by another package', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    ensurePreinstalledApps(service, shipped);
    expect(() => service.uninstall('workspace')).toThrow(/preinstalled App/);
    expect(() => service.setEnabled('workspace', false)).toThrow(/preinstalled App/);
    const impostor = path.join(path.dirname(shipped), 'impostor');
    bundle(impostor, 'workspace', '9.9.9');
    const { manifestDigest } = service.inspectDirectory(impostor);
    expect(() => service.installFromDirectory(impostor, manifestDigest, 'folder')).toThrow(/preinstalled App/);
    expect(service.get('workspace').manifest.version).toBe('1.0.0');
    // Control: an ordinary App can be switched off and uninstalled.
    const plain = path.join(path.dirname(shipped), 'plain');
    bundle(plain, 'plain-app', '1.0.0');
    service.installFromDirectory(plain, service.inspectDirectory(plain).manifestDigest, 'folder');
    service.setEnabled('plain-app', false);
    service.uninstall('plain-app');
  });

  it('an uninstalled App may do nothing: asked, the service says no instead of throwing (10-06)', () => {
    const plain = path.join(path.dirname(shipped), 'plain-gone');
    bundle(plain, 'plain-gone', '1.0.0');
    service.installFromDirectory(plain, service.inspectDirectory(plain).manifestDigest, 'folder');
    expect(service.hasCapability('plain-gone', 'files:read')).toBe(true);
    service.uninstall('plain-gone');
    expect(service.isInstalled('plain-gone')).toBe(false);
    // Both ways in: the file-sync relay asks hasCapability, a workspace watch asks grantedCapabilities (复核 71).
    expect(service.grantedCapabilities('plain-gone')).toEqual([]);
    expect(service.hasCapability('plain-gone', 'files:read')).toBe(false);
  });

  it('a shipped folder that does not validate is reported, and the others still install', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    mkdirSync(path.join(shipped, 'broken'), { recursive: true });
    writeFileSync(path.join(shipped, 'broken', 'manifest.json'), '{ not json');
    const report = ensurePreinstalledApps(service, shipped);
    expect(report.installed).toEqual(['workspace']);
    expect(report.failed).toEqual(['broken']);
  });

  it('one an earlier build shipped and this one does not: left where it is, now the person\'s market App — kept as it was, switched off and on, uninstalled, and never put back', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    bundle(path.join(shipped, 'searcher'), 'searcher', '0.2.6');
    ensurePreinstalledApps(service, shipped);
    expect(service.origins().searcher).toBe('preinstalled');
    // The next build carries the workspace alone.
    rmSync(path.join(shipped, 'searcher'), { recursive: true });
    const report = ensurePreinstalledApps(service, shipped);
    expect(report).toMatchObject({ installed: ['workspace'], failed: [], released: ['searcher'] });
    expect(service.origins()).toMatchObject({ workspace: 'preinstalled', searcher: 'market' });
    // Only where it came from changed: the same bytes, the same grants, still on.
    expect(service.get('searcher').manifest.version).toBe('0.2.6');
    expect(readFileSync(path.join(root, 'searcher', 'index.html'), 'utf8')).toContain('searcher 0.2.6');
    expect(service.grantedCapabilities('searcher')).toEqual(['files:read', 'files:write']);
    expect(service.isEnabled('searcher')).toBe(true);
    // Released once: the next start has nothing more to say about it.
    expect(ensurePreinstalledApps(service, shipped).released).toEqual([]);
    // An ordinary App now, unlike the workspace: switched off and on, uninstalled — and a start does not bring it back.
    service.setEnabled('searcher', false);
    expect(service.isEnabled('searcher')).toBe(false);
    service.setEnabled('searcher', true);
    service.uninstall('searcher');
    ensurePreinstalledApps(service, shipped);
    expect(service.isInstalled('searcher')).toBe(false);
    expect(() => service.setEnabled('workspace', false)).toThrow(/preinstalled App/);
  });

  it('a shipped folder that does not install this start is still shipped: its App is not released', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    ensurePreinstalledApps(service, shipped);
    writeFileSync(path.join(shipped, 'workspace', 'manifest.json'), '{ not json');
    const report = ensurePreinstalledApps(service, shipped);
    expect(report).toMatchObject({ failed: ['workspace'], released: [] });
    expect(service.origins().workspace).toBe('preinstalled');
  });

  it('no shipped folder at all releases nothing — a broken build is not one that stopped shipping its Apps', () => {
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    ensurePreinstalledApps(service, shipped);
    expect(ensurePreinstalledApps(service, path.join(shipped, 'absent')).released).toEqual([]);
    expect(service.origins().workspace).toBe('preinstalled');
  });

  it('only an App recorded as preinstalled can be released', () => {
    const plain = path.join(path.dirname(shipped), 'plain-release');
    bundle(plain, 'plain-release', '1.0.0');
    service.installFromDirectory(plain, service.inspectDirectory(plain).manifestDigest, 'folder');
    expect(() => service.releasePreinstalled('plain-release')).toThrow(/not a preinstalled App/);
    expect(() => service.releasePreinstalled('nothing-here')).toThrow(/not a preinstalled App/);
    expect(service.origins()['plain-release']).toBe('folder');
  });

  it('no shipped directory installs nothing and says so — a gugu server package once shipped none, and nobody heard', () => {
    vi.mocked(log.error).mockClear();
    const absent = path.join(shipped, 'absent');
    expect(ensurePreinstalledApps(service, absent)).toEqual({ installed: [], failed: [], missing: absent, released: [] });
    expect(log.error).toHaveBeenCalledWith('extensions: the preinstalled Apps folder is missing, so none are installed', { root: absent });
    // Control: a folder that is there is not reported missing, and logs no error.
    vi.mocked(log.error).mockClear();
    bundle(path.join(shipped, 'workspace'), 'workspace', '1.0.0');
    expect(ensurePreinstalledApps(service, shipped).missing).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });
});

/**
 * Only an App opened from the market shelf gets the default author line (#6761); a preinstalled
 * App is on no shelf, so without its own `author` the detail page's author row is empty.
 */
function appsWithoutAuthor(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(dir, entry.name, 'manifest.json')))
    .filter((entry) => {
      const manifest = JSON.parse(readFileSync(path.join(dir, entry.name, 'manifest.json'), 'utf8')) as { author?: unknown };
      return typeof manifest.author !== 'string' || manifest.author.trim() === '';
    })
    .map((entry) => entry.name);
}

describe('what gugu ships in apps/desktop/preinstalled-apps', () => {
  it('every App names its author', () => {
    // Control: the check does see a missing author.
    const base = mkdtempSync(path.join(tmpdir(), 'gugu-preinstalled-author-'));
    bundle(path.join(base, 'named'), 'named', '1.0.0');
    mkdirSync(path.join(base, 'anonymous'));
    writeFileSync(path.join(base, 'anonymous', 'manifest.json'), JSON.stringify({ id: 'anonymous', name: 'anonymous' }));
    expect(appsWithoutAuthor(base)).toEqual(['anonymous']);

    const repoDir = fileURLToPath(new URL('../../../../../preinstalled-apps', import.meta.url));
    expect(existsSync(repoDir)).toBe(true);
    expect(appsWithoutAuthor(repoDir)).toEqual([]);
  });
});
