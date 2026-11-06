import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { ExtensionsService } from './extensions-service';

const OWNER = '11000000-0000-4000-8000-000000000001';
const OTHER = '22000000-0000-4000-8000-000000000002';
const CHAT = '33000000-0000-4000-8000-000000000003';
const ID = 'unread-reader';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function manifest(name = 'main', granted = true) {
  return { id: ID, name: 'Unread reader', version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
    defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html',
    permissions: granted ? { capabilities: ['chat:unread'], bindings: [{ name, kind: 'conversation', actions: ['unread'] }] } : {},
    contributes: { tabs: [{ name: 'main', title: 'Unread reader' }] } };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'app-unread-grant-')); roots.push(root);
  const source = path.join(root, 'source'); mkdirSync(source);
  writeFileSync(path.join(source, 'index.html'), '<p>Unread reader</p>');
  const installed = path.join(root, 'installed');
  const service = new ExtensionsService(installed);
  const install = (value = manifest(), publisher = OWNER) => {
    writeFileSync(path.join(source, 'manifest.json'), JSON.stringify(value));
    service.installFromDirectory(source, service.inspectDirectory(source).manifestDigest, 'folder', { id: publisher });
  };
  install(); return { service, installed, install };
}

describe('one-conversation unread permission boundary', () => {
  it('rejects content actions, multiple targets, unknown target authority and older API declarations', () => {
    const good = manifest(); expect(() => parseExtensionManifest(good)).not.toThrow();
    for (const bindings of [
      [{ name: 'main', kind: 'conversation', actions: ['unread', 'read'] }],
      [{ name: 'main', kind: 'conversation', actions: ['unread'], chatId: CHAT }],
      [{ name: 'main', kind: 'conversation', actions: ['unread'] }, { name: 'other', kind: 'conversation', actions: ['unread'] }],
    ]) expect(() => parseExtensionManifest({ ...good, permissions: { capabilities: ['chat:unread'], bindings } })).toThrow();
    expect(() => parseExtensionManifest({ ...good, permissions: { capabilities: ['chat:unread'] } })).toThrow();
    expect(() => parseExtensionManifest({ ...good, apiVersion: 30 })).toThrow();
  });

  it('persists a selection across host restart, partitioned by actual account and installed publisher', () => {
    const { service, installed } = fixture();
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const binding = service.conversationUnreadBinding(OWNER, ID, 'main');
    expect(binding?.chatId).toBe(CHAT);
    expect(new ExtensionsService(installed).conversationUnreadBinding(OWNER, ID, 'main')).toEqual(binding);
    expect(service.conversationUnreadBinding(OTHER, ID, 'main')).toBeNull();
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'other')).toThrow();
    expect(service.hasCapability(ID, 'chat:read')).toBe(false);
    expect(service.hasCapability(ID, 'agents:control')).toBe(false);
  });

  it('refuses actual content, other-chat content, chat enumeration and Agent control at the shared bridge door', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    const caller = { kind: 'page' as const, gesture: true, widget: false, has: (word: Parameters<ExtensionsService['hasCapability']>[1]) => service.hasCapability(ID, word) };
    expect(callRefusal('bindingsGet', { name: 'main' }, caller)).toBeNull();
    for (const [verb, args] of [
      ['messagesHistory', { chat: CHAT }], ['messagesHistory', { chat: OTHER }],
      ['messagesSearch', { chat: CHAT, query: 'secret' }], ['chatsList', {}],
      ['chatsMembers', { chat: OTHER }], ['dispatch', { text: 'run', to: { agent: `user:${OTHER}` } }],
    ] as const) expect(callRefusal(verb, args, caller)?.code).toBe('denied');
  });

  it('invalidates the selection on revocation and does not revive it when the capability is restored', () => {
    const { service } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setPermissionGranted(ID, 'chat:unread', false);
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'main')).toThrow();
    service.setPermissionGranted(ID, 'chat:unread', true);
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
  });

  it('does not transfer a target to a different publisher, renamed declaration or reinstall', () => {
    const { service, install } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(manifest(), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    install(manifest('changed'), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'changed')).toBeNull();
    service.setConversationUnreadBinding(OWNER, ID, 'changed', CHAT);
    service.uninstall(ID); install(manifest('changed'), OTHER);
    expect(service.conversationUnreadBinding(OWNER, ID, 'changed')).toBeNull();
  });

  it('stops authority while disabled and removes the old target when its declaration is removed', () => {
    const { service, install } = fixture(); service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
    service.setEnabled(ID, false);
    expect(() => service.conversationUnreadBinding(OWNER, ID, 'main')).toThrow();
    service.setEnabled(ID, true);
    install(manifest('main', false)); install();
    expect(service.conversationUnreadBinding(OWNER, ID, 'main')).toBeNull();
  });

  it('does not reuse a permission selection authority across accounts', () => {
    const { service } = fixture();
    expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(service.conversationUnreadAuthority(OTHER, ID, 'main'));
  });

  it.each(['rebind', 'remove', 'revoke-restore', 'disable-enable', 'compatible-upgrade', 'publisher-change', 'reinstall'])(
    'invalidates a pending permission selection on %s', change => {
      const { service, install } = fixture();
      service.setConversationUnreadBinding(OWNER, ID, 'main', CHAT);
      const authority = service.conversationUnreadAuthority(OWNER, ID, 'main');
      expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).toBe(authority);
      switch (change) {
        case 'rebind': service.setConversationUnreadBinding(OWNER, ID, 'main', OTHER); break;
        case 'remove': service.setConversationUnreadBinding(OWNER, ID, 'main', null); break;
        case 'revoke-restore': service.setPermissionGranted(ID, 'chat:unread', false); service.setPermissionGranted(ID, 'chat:unread', true); break;
        case 'disable-enable': service.setEnabled(ID, false); service.setEnabled(ID, true); break;
        case 'compatible-upgrade': install(); expect(service.conversationUnreadBinding(OWNER, ID, 'main')?.chatId).toBe(CHAT); break;
        case 'publisher-change': install(manifest(), OTHER); break;
        case 'reinstall': service.uninstall(ID); install(); break;
      }
      expect(service.conversationUnreadAuthority(OWNER, ID, 'main')).not.toBe(authority);
    },
  );
});
