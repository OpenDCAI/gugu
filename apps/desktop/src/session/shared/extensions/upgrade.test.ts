import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest, type ExtensionManifest } from './manifest';
import { addedPermissions, keptRevocations, replacesWithoutAsking, type ExtensionOrigin } from './upgrade';

function manifest(version: string, permissions: { capabilities?: string[]; network?: string[] } = {}): ExtensionManifest {
  return parseExtensionManifest({
    id: 'notes',
    name: 'Notes',
    version,
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    permissions,
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  });
}

describe('addedPermissions: what a version newly declares', () => {
  it('counts everything a first install declares', () => {
    expect(addedPermissions(undefined, [], manifest('1.0.0', { capabilities: ['files:read'], network: ['a.example.com'] })))
      .toEqual({ capabilities: ['files:read'], network: ['a.example.com'] });
  });

  it('counts nothing when the declarations did not change', () => {
    const v1 = manifest('1.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
    expect(addedPermissions(v1, [], manifest('2.0.0', { capabilities: ['files:read'], network: ['a.example.com'] })))
      .toEqual({ capabilities: [], network: [] });
  });

  it('counts a new capability and a new host, each on its own', () => {
    const v1 = manifest('1.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
    const v2 = manifest('2.0.0', { capabilities: ['files:read', 'files:write'], network: ['a.example.com', 'b.example.com'] });
    expect(addedPermissions(v1, [], v2)).toEqual({ capabilities: ['files:write'], network: ['b.example.com'] });
  });

  it('does not count a permission the person took back when the next version declares it again', () => {
    const v1 = manifest('1.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
    const v2 = manifest('2.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
    expect(addedPermissions(v1, ['files:read', 'a.example.com'], v2)).toEqual({ capabilities: [], network: [] });
  });

  it('does not count a host under a wildcard that is still granted, and counts one under a withdrawn wildcard', () => {
    const v1 = manifest('1.0.0', { network: ['*.example.com'] });
    const v2 = manifest('2.0.0', { network: ['api.example.com'] });
    expect(addedPermissions(v1, [], v2).network).toEqual([]);
    // The withdrawal is kept per written entry: `api.example.com` is not on it, so not asking would hand it over.
    expect(addedPermissions(v1, ['*.example.com'], v2).network).toEqual(['api.example.com']);
  });
});

describe('replacesWithoutAsking: the one rule — the same source replacing its own copy with nothing new', () => {
  const v1 = manifest('1.0.0', { capabilities: ['files:read'] });
  const same = manifest('2.0.0', { capabilities: ['files:read'] });
  const wider = manifest('2.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
  const ask = (
    installed: ExtensionManifest | undefined,
    installedOrigin: ExtensionOrigin | undefined,
    candidate: ExtensionManifest,
    origin: ExtensionOrigin,
    revokedPermissions: string[] = [],
    publishers: { installedPublisher?: string | null; publisher?: string | null } = {}
  ) => replacesWithoutAsking({ installed, installedOrigin, revokedPermissions, candidate, origin, ...publishers });

  it.each(['folder', 'market'] as const)('a %s copy replaced by its own source replaces without asking', (origin) => {
    expect(ask(v1, origin, same, origin)).toBe(true);
  });

  it('a chat package replaced by one its own publisher sent replaces without asking', () => {
    expect(ask(v1, 'attachment', same, 'attachment', [], { installedPublisher: 'u-bob', publisher: 'u-bob' })).toBe(true);
  });

  it('asks when the chat package comes from someone else, or either publisher is unknown (摩擦单 F66)', () => {
    expect(ask(v1, 'attachment', same, 'attachment', [], { installedPublisher: 'u-bob', publisher: 'u-eve' })).toBe(false);
    expect(ask(v1, 'attachment', same, 'attachment', [], { installedPublisher: null, publisher: 'u-bob' })).toBe(false);
    expect(ask(v1, 'attachment', same, 'attachment', [], { installedPublisher: 'u-bob', publisher: null })).toBe(false);
  });

  it('still replaces without asking when the person took something back, which stays taken back', () => {
    expect(ask(v1, 'folder', same, 'folder', ['files:read'])).toBe(true);
    expect(ask(v1, 'market', same, 'market', ['files:read'])).toBe(true);
  });

  it.each(['folder', 'market'] as const)('asks when the %s version declares something new', (origin) => {
    expect(ask(v1, origin, wider, origin)).toBe(false);
  });

  it('asks on a first install: nothing is being replaced', () => {
    expect(ask(undefined, undefined, same, 'folder')).toBe(false);
    expect(ask(undefined, undefined, same, 'market')).toBe(false);
  });

  it.each(['market', 'attachment', undefined] as const)('a folder asks when the installed copy came from %s (E-05)', (installedOrigin) => {
    expect(ask(v1, installedOrigin, same, 'folder')).toBe(false);
  });

  it.each(['folder', 'attachment', undefined] as const)('the market asks when the installed copy came from %s', (installedOrigin) => {
    expect(ask(v1, installedOrigin, same, 'market')).toBe(false);
  });

  it('a preinstalled App is never replaced this way', () => {
    expect(ask(v1, 'preinstalled', same, 'preinstalled')).toBe(false);
  });
});

describe('keptRevocations: what an install keeps of the withdrawals', () => {
  it('keeps every withdrawal the new version still declares and drops the ones it no longer declares', () => {
    const v2 = manifest('2.0.0', { capabilities: ['files:read'], network: ['a.example.com'] });
    expect(keptRevocations(['files:read', 'b.example.com', 'a.example.com'], v2)).toEqual(['files:read', 'a.example.com']);
  });

  it('keeps nothing when nothing was taken back', () => {
    expect(keptRevocations([], manifest('2.0.0', { capabilities: ['files:read'] }))).toEqual([]);
  });
});
