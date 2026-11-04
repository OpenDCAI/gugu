import { describe, expect, it } from 'vitest';
import { capabilityCovered, EXTENSION_API_VERSION, grantedReach, safeParseExtensionManifest, withCoveredCapabilities } from './manifest';
import { permissionSide } from './catalog';

/**
 * PR-5b: an `agents:*` word reaches the App's own agents, this computer's (`:all`) or all the person's computers'
 * (`:all-machines`). A widened meaning is a new word (owner 10-05): `:all` keeps meaning this computer, so an App
 * installed with it is never silently given more.
 */
describe('agents:* reach', () => {
  it('a wider word covers the narrower ones of its family, never the other way round', () => {
    expect(capabilityCovered(['agents:read:all-machines'], 'agents:read')).toBe(true);
    expect(capabilityCovered(['agents:read:all-machines'], 'agents:read:all')).toBe(true);
    expect(capabilityCovered(['agents:read:all'], 'agents:read')).toBe(true);
    expect(capabilityCovered(['agents:read:all'], 'agents:read:all-machines')).toBe(false);
    expect(capabilityCovered(['agents:read'], 'agents:read:all')).toBe(false);
    // Another family is never covered.
    expect(capabilityCovered(['agents:read:all-machines'], 'agents:control')).toBe(false);
    expect(capabilityCovered(['files:read'], 'files:write')).toBe(false);
  });

  it('the granted words with every narrower word they cover — what a check finds — and nothing wider or of another family', () => {
    expect(withCoveredCapabilities(['files:read:all-machines', 'chat:relay'])).toEqual(['files:read', 'files:read:all-machines', 'chat:relay']);
    expect(withCoveredCapabilities(['files:read', 'agents:control:all'])).toEqual(['files:read', 'agents:control', 'agents:control:all']);
  });

  it('the reach an App was granted: the widest of its family, own when only the bare word', () => {
    expect(grantedReach(['agents:control'], 'agents:control')).toBe('own');
    expect(grantedReach(['agents:control:all'], 'agents:control')).toBe('all');
    expect(grantedReach(['agents:read:all-machines', 'agents:control:all'], 'agents:control')).toBe('all');
    expect(grantedReach(['agents:read:all-machines', 'agents:control:all'], 'agents:read')).toBe('all-machines');
    expect(grantedReach([], 'agents:history')).toBe('own');
  });
});

describe('a manifest declares one word per family', () => {
  const manifest = (capabilities: string[]) => ({
    id: 'radar-test',
    name: 'Radar test',
    version: '0.1.0',
    apiVersion: EXTENSION_API_VERSION,
    defaultLocale: 'en',
    entry: 'index.html',
    permissions: { capabilities, network: [] },
    contributes: { tabs: [{ name: 'main', title: 'Radar' }] },
  });

  it('any two words of one family are refused; one of each family is fine', () => {
    expect(safeParseExtensionManifest(manifest(['agents:read:all-machines', 'agents:control:all-machines'])).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest(['agents:read:all', 'agents:control'])).ok).toBe(true);
    expect(safeParseExtensionManifest(manifest(['files:read:all-machines', 'files:write'])).ok).toBe(true);
    for (const pair of [
      ['agents:read', 'agents:read:all'],
      ['agents:read', 'agents:read:all-machines'],
      ['agents:read:all', 'agents:read:all-machines'],
      ['agents:control:all-machines', 'agents:control'],
      ['files:read', 'files:read:all-machines'],
    ]) {
      const parsed = safeParseExtensionManifest(manifest(pair));
      expect(parsed.ok, pair.join(' + ')).toBe(false);
      if (!parsed.ok) expect(parsed.issues.join('\n')).toContain('同一个能力的两档');
    }
  });

  it('agents:history and files:write have no all-machines word (history does not leave this computer; no wider write)', () => {
    expect(safeParseExtensionManifest(manifest(['agents:history:all-machines'])).ok).toBe(false);
    expect(safeParseExtensionManifest(manifest(['files:write:all-machines'])).ok).toBe(false);
  });
});

it('the product page lists files:read:all-machines with what the App can see, as files:read', () => {
  const sides = (['files:read:all-machines', 'files:read', 'files:write'] as const).map((key) => permissionSide({ kind: 'capability', key, risk: 'high' }));
  expect(sides).toEqual(['see', 'see', 'do']);
});
