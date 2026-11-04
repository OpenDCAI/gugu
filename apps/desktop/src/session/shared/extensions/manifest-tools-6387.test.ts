import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest, safeParseExtensionManifest } from './manifest';
import { guguLinkScheme } from '@gugu/core/shared/ui/guguLink';

/**
 * #6387 What a manifest must say before an extension may give agents its own MCP programs and
 * skills: the install sheet has to name them, so a bundle that brings either without
 * `agents:tools` does not parse at all.
 */

const base = {
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
  entry: 'main.html',
  contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
};
const server = { name: 'notes', command: 'node', args: ['mcp/server.js'] };

function issues(raw: unknown): string {
  const result = safeParseExtensionManifest(raw);
  return result.ok ? '' : result.issues.join(' ');
}

describe('contributes.mcpServers / skills (#6387)', () => {
  it('parses a bundle that brings an MCP program and skills and declares agents:tools', () => {
    const manifest = parseExtensionManifest({
      ...base,
      permissions: { capabilities: ['agents:tools', 'notifications'] },
      contributes: { ...base.contributes, mcpServers: [{ ...server, env: { NOTES_MODE: 'strict' } }], skills: 'skills', instructions: 'Test tools.' },
    });
    expect(manifest.contributes.mcpServers?.[0]).toMatchObject({ command: 'node' });
    expect(manifest.contributes.skills).toBe('skills');
  });

  it('refuses MCP programs or skills the install sheet would not mention', () => {
    expect(issues({ ...base, contributes: { ...base.contributes, mcpServers: [server], instructions: 'Test tools.' } })).toMatch(/must declare "agents:tools"/);
    expect(issues({ ...base, contributes: { ...base.contributes, skills: 'skills', instructions: 'Test tools.' } })).toMatch(/must declare "agents:tools"/);
  });

  it('refuses agents:tools with nothing to give, duplicate names, bad names and escaping skill paths', () => {
    expect(issues({ ...base, permissions: { capabilities: ['agents:tools'] } })).toMatch(/no contributes.mcpServers/);
    const withServers = (mcpServers: unknown[]) => ({
      ...base,
      permissions: { capabilities: ['agents:tools'] },
      contributes: { ...base.contributes, mcpServers, instructions: 'Test tools.' },
    });
    expect(issues(withServers([server, server]))).toMatch(/duplicate MCP server name "notes"/);
    expect(issues(withServers([{ ...server, name: 'Notes!' }]))).not.toBe('');
    expect(issues(withServers([{ ...server, env: { 'bad-name': 'x' } }]))).not.toBe('');
    expect(
      issues({ ...base, permissions: { capabilities: ['agents:tools'] }, contributes: { ...base.contributes, skills: '../outside', instructions: 'Test tools.' } }),
    ).not.toBe('');
  });

  it('摩擦单 F77 a tools module is a program too: a .js/.mjs file inside the bundle, never mixed with a command', () => {
    const withServers = (mcpServers: unknown[]) => ({
      ...base,
      permissions: { capabilities: ['agents:tools'] },
      contributes: { ...base.contributes, mcpServers, instructions: 'Test tools.' },
    });
    const manifest = parseExtensionManifest(withServers([{ tools: 'lib/tools.mjs' }, { ...server, name: 'index' }]));
    expect(manifest.contributes.mcpServers?.map((one) => ('host' in one ? one.host : 'tools' in one ? one.tools : one.command))).toEqual(['lib/tools.mjs', 'node']);
    expect(issues(withServers([{ tools: '../tools.js' }]))).toMatch(/inside the bundle/);
    expect(issues(withServers([{ tools: 'tools.ts' }]))).toMatch(/inside the bundle/);
    expect(issues(withServers([{ tools: 'tools.js', command: 'node' }]))).not.toBe('');
  });

  // 摩擦单 F119 (S22: the author named the program "signup" and told the group `badminton-signup__subscribe`, which was
  // `badminton-signup-signup__subscribe`) A tools module has no name of its own: it is the App's. Control (the parent):
  // `name` was required, and a program not named after the App put its name into every tool's.
  it('摩擦单 F119 a tools module is named after its App: no name of its own, and one per App', () => {
    const withServers = (mcpServers: unknown[]) => ({
      ...base,
      permissions: { capabilities: ['agents:tools'] },
      contributes: { ...base.contributes, mcpServers, instructions: 'Test tools.' },
    });
    // L11 R9: said so, not a bare "Invalid input".
    expect(issues(withServers([{ name: 'signup', tools: 'tools.js' }]))).toMatch(/no name: it is the App's/);
    expect(issues(withServers([{ tools: 'tools.js' }, { tools: 'more.js' }]))).toMatch(/one tools module per App/);
    // A command program named after the App is the same name as the App's tools module.
    expect(issues(withServers([{ tools: 'tools.js' }, server]))).toMatch(/duplicate MCP server name "notes"/);
  });
});

describe('guguLinkScheme (#6387)', () => {
  it('gives each build channel its own scheme, so side-by-side installs never steal links', () => {
    expect(guguLinkScheme({ tier: 'production', devLaunch: false })).toBe('gugu');
    expect(guguLinkScheme({ tier: undefined, devLaunch: false })).toBe('gugu');
    expect(guguLinkScheme({ tier: 'beta', devLaunch: false })).toBe('gugu-beta');
    expect(guguLinkScheme({ tier: 'acceptance_v0.2', devLaunch: false })).toBe('gugu-acceptance-v0-2');
    expect(guguLinkScheme({ tier: 'production', devLaunch: true })).toBe('gugu-dev');
  });
});
