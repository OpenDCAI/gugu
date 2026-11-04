import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, EXTENSION_CAPABILITIES, parseExtensionManifest, safeParseExtensionManifest } from '@shared/extensions/manifest';
import { enUSMessages, zhCNMessages } from '@renderer/localization/messages';
import { consentPrompt, describeCapability, describePermissions, programDetails, type SessionTranslate } from './extension-consent';

/**
 * A capability word means the same wherever the App works (owner 10-05 23:29), so the consent says its whole reach once.
 * Before (摩擦单 F6) `workspace:*` was said per place an App declared — a group's App's word read "the chat's workspace",
 * and reached that alone.
 */
const translate = ((key: string) => key) as unknown as SessionTranslate;

function app(opensFiles?: unknown, capabilities: string[] = ['files:read', 'files:write']) {
  return parseExtensionManifest({
    id: 'vote',
    name: 'Vote',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    permissions: { capabilities },
    contributes: { tabs: [{ name: 'main', title: 'Vote', ...(opensFiles === undefined ? {} : { opensFiles }) }] },
  });
}

const PLACES = [{ chat: ['.vote.json'] }, { session: ['.csv'] }, { session: ['.csv'], chat: ['.csv'] }, undefined];

describe('a capability is one sentence wherever the App works', () => {
  it('files:*, chat:relay and asking for nothing: the same sentence for a chat\'s App, a session\'s, both and neither', () => {
    for (const where of PLACES) {
      expect(describeCapability('files:read', app(where), translate)).toBe('extensions.permissionsFilesRead');
      expect(describeCapability('files:write', app(where), translate)).toBe('extensions.permissionsFilesWrite');
      expect(describeCapability('chat:relay', app(where), translate)).toBe('extensions.permissionsChatRelay');
      expect(describePermissions({ ...app(where), permissions: {} }, translate)).toBe('extensions.permissionsNone');
    }
  });

  it('the sentences say the whole reach: every chat you are in, this computer\'s sessions; the narrow agents words, its own', () => {
    expect(zhCNMessages['extensions.permissionsFilesRead']).toBe('读你所在的所有对话里的文件，和{computer}上各个会话里的文件');
    expect(enUSMessages['extensions.permissionsChatRelay']).toContain('any chat you are in');
    expect(zhCNMessages['extensions.permissionsAgentsRead']).toContain('这个 App 自己起的');
  });
});

// 161 10-15 (owner: a consent says its reach as it is): an App installed on another machine from this one's App page — every
// sentence names that machine. Before, the files and every-agent sentences said 「这台电脑」 whichever machine it went on.
describe('the computer an App reaches is named as it is', () => {
  const say = (messages: Record<string, string>) =>
    ((key: string, params: Record<string, string> = {}) =>
      messages[key]!.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? `{${name}}`)) as unknown as SessionTranslate;
  const reaching = app(undefined, ['files:read', 'files:write', 'agents:read:all', 'agents:history:all', 'agents:control:all']);

  it('another machine: its name in every sentence, 「这台电脑」 / 「this computer」 in none', () => {
    const zh = describePermissions(reaching, say(zhCNMessages), 'Mac 1').split('\n');
    expect(zh).toHaveLength(5);
    for (const line of zh) expect(line).toContain('「Mac 1」');
    expect(zh.join('\n')).not.toContain('这台电脑');
    const en = describePermissions(reaching, say(enUSMessages), 'Mac 1');
    expect(en.match(/Mac 1/g)).toHaveLength(5);
    expect(en).not.toContain('this computer');
  });

  it('control: this computer — said so, and no placeholder is left', () => {
    const zh = describePermissions(reaching, say(zhCNMessages));
    expect(zh.match(/这台电脑/g)).toHaveLength(5);
    expect(zh).not.toContain('{computer}');
    expect(describePermissions(reaching, say(enUSMessages))).not.toContain('{computer}');
  });
});

// 125 (10-06 00:49): an App updated across the rename asks for the new words as new — whether what is installed declared
// other words (its manifest still reads) or the old ones (it no longer does: refused, and the update asks as a first install).
describe('the renamed words are asked again on update', () => {
  const sayKeys = ((key: string, params?: Record<string, string>) => (params?.permissions ? `${key}(${params.permissions})` : key)) as unknown as SessionTranslate;
  const next = app({ chat: ['.vote.json'] }, ['files:read', 'chat:relay', 'agents:read:all']);

  it('installed with other words: files:read and chat:relay are this version\'s new ones', () => {
    const installed = app({ chat: ['.vote.json'] }, ['agents:read:all']);
    const prompt = consentPrompt(installed, [], { ...next, version: '1.1.0' }, sayKeys, 'en-US');
    expect(prompt.description).toBe('extensions.updateNewPermissions(extensions.permissionsFilesRead\nextensions.permissionsChatRelay)');
  });

  // 125 10-06: no table from old words to new ones. An old word is an unknown word, refused naming the words there are.
  it('installed with the old words: that manifest is refused like any unknown word, naming the words there are — and the update asks for everything', () => {
    const old = { id: 'vote', name: 'Vote', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Vote' }] } };
    for (const word of ['workspace:read', 'workspace:write', 'conversation:relay', 'files:all']) {
      const parsed = safeParseExtensionManifest({ ...old, permissions: { capabilities: [word] } });
      expect(parsed.ok).toBe(false);
      const said = JSON.stringify(parsed);
      expect(said).not.toContain('is now');
      for (const known of ['files:read', 'files:write', 'chat:relay', 'agents:read:all']) expect(said).toContain(known);
    }
    // Control: the same manifest with this version's word reads.
    expect(safeParseExtensionManifest({ ...old, permissions: { capabilities: ['files:read'] } }).ok).toBe(true);
    expect(consentPrompt(undefined, [], next, sayKeys, 'en-US').description).toBe(
      'extensions.permissionsFilesRead\nextensions.permissionsChatRelay\nextensions.permissionsAgentsReadAll',
    );
  });
});

// The design shots (10-01): the consent sheet showed 「所有**项目」 — the sheet, the switches and the detail page show these
// sentences as plain text, so a markdown mark in one reaches the person as it is.
describe('a capability sentence is plain text, in both languages', () => {
  it('every capability, said for both places: no markdown marks', () => {
    const everything = { ...app({ session: ['.csv'], chat: ['.csv'] }), permissions: { capabilities: [...EXTENSION_CAPABILITIES] } };
    for (const messages of [zhCNMessages, enUSMessages]) {
      const say = ((key: string) => (messages as Record<string, string>)[key]) as unknown as SessionTranslate;
      expect(describePermissions(everything, say)).not.toContain('*');
    }
  });
});

/**
 * agents:tools says what runs (摩擦单 F77) in two layers (App 插件体验, owner 10-06「node launch.mjs 没人看得懂」): the plain
 * sentence — a program of its own runs, and what such a program can reach — and, in the details, every command line.
 */
describe('agents:tools: the plain sentence, then what runs word for word', () => {
  const said = ((key: string, params?: Record<string, string>) => (params?.skills !== undefined ? `${key}(${params.skills})` : key)) as unknown as SessionTranslate;
  const board = (contributes: Record<string, unknown>) => parseExtensionManifest({
    id: 'board',
    name: 'Board',
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    permissions: { capabilities: ['agents:tools'] },
    contributes: { tabs: [{ name: 'main', title: 'Board' }], instructions: 'Board tools.', ...contributes },
  });
  const programs = [{ tools: 'tools.js' }, { name: 'py', command: 'uvx', args: ['board-mcp'] }];

  it('names no command in the sentence: a tools module by its file, a command by its line, in the details', () => {
    const manifest = board({ mcpServers: programs });
    expect(describeCapability('agents:tools', manifest, said)).toBe('extensions.permissionsAgentsTools()');
    expect(programDetails(manifest, said)).toEqual({
      label: 'extensions.consentDetails',
      caption: 'extensions.consentDetailsCommands',
      lines: ['tools.js', 'uvx board-mcp'],
    });
    const prompt = consentPrompt(undefined, [], manifest, said, 'en-US');
    expect(prompt.details?.lines).toEqual(['tools.js', 'uvx board-mcp']);
    expect(prompt.description).not.toContain('board-mcp');
  });

  it('#7317 Computer Use says what it is: a view of gugu\'s computer control, giving agents nothing — on the computer it installs on', () => {
    const where = ((key: string, params?: Record<string, string>) => `${key}[${params?.computer ?? ''}]`) as unknown as SessionTranslate;
    const view = board({ mcpServers: [{ name: 'computer-use', host: 'computer-use' }] });
    expect(describeCapability('agents:tools', view, where)).toBe('extensions.permissionsComputerUseView[extensions.permissionsThisComputer[]]');
    expect(describeCapability('agents:tools', view, where, 'mac1')).toBe('extensions.permissionsComputerUseView[extensions.permissionsOnMachine[]]');
    // Control: an App with a program of its own beside it still says that its program runs.
    expect(describeCapability('agents:tools', board({ mcpServers: [{ name: 'computer-use', host: 'computer-use' }, ...programs] }), said))
      .toBe('extensions.permissionsAgentsTools()');
    // Both languages say it.
    expect([enUSMessages['extensions.permissionsComputerUseView'], zhCNMessages['extensions.permissionsComputerUseView']].every((text) => text.includes('{computer}'))).toBe(true);
  });

  it('skills ride along in the sentence; skills alone run nothing and have no details', () => {
    expect(describeCapability('agents:tools', board({ mcpServers: programs, skills: 'skills' }), said))
      .toBe('extensions.permissionsAgentsTools(extensions.permissionsAgentsToolsSkills)');
    const skillsOnly = board({ skills: 'skills' });
    expect(describeCapability('agents:tools', skillsOnly, said)).toBe('extensions.permissionsAgentsSkillsOnly');
    expect(programDetails(skillsOnly, said)).toBeUndefined();
  });

  it('a first install of an App that lists its tools says so; an upgrade, which never turns that switch, does not', () => {
    const listed = board({ mcpServers: programs, toolsListed: true });
    expect(consentPrompt(undefined, [], listed, said, 'en-US').description).toContain('extensions.consentToolsListed');
    expect(consentPrompt(board({ mcpServers: programs }), [], listed, said, 'en-US').description).not.toContain('extensions.consentToolsListed');
    expect(consentPrompt(undefined, [], board({ mcpServers: programs }), said, 'en-US').description).not.toContain('extensions.consentToolsListed');
  });

  // D-31 A-B 10-06: answered on the phone or on desktop A, 「给这台电脑上的 agent」 named the wrong computer.
  it('asked on another device: the computer it installs on is named — its agents, its files', () => {
    const on = ((key: string, params?: Record<string, string>) => (params?.machine ? `${key}@${params.machine}` : key)) as unknown as SessionTranslate;
    expect(consentPrompt(undefined, [], board({ mcpServers: programs }), on, 'en-US', undefined, 'mac1').description).toBe('extensions.permissionsAgentsToolsOn@mac1');
    expect(consentPrompt(undefined, [], board({ skills: 'skills' }), on, 'en-US', undefined, 'mac1').description).toBe('extensions.permissionsAgentsSkillsOnlyOn@mac1');
    // Control: asked on the computer it installs on, 「这台电脑」 as ever.
    expect(consentPrompt(undefined, [], board({ mcpServers: programs }), on, 'en-US').description).toBe('extensions.permissionsAgentsTools');
  });
});
