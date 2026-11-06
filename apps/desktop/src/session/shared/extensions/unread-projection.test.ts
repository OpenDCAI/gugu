import { describe, expect, it } from 'vitest';
import { conversationUnreadProjection } from './unread-projection';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';
const ownerId = 'owner-a';
const binding = { ownerId, name: 'main', handle: 'opaque', chatId: 'selected-chat' };
const project = (chats: { id: string; unread_count: number }[], patch: Partial<Parameters<typeof conversationUnreadProjection>[0]> = {}) =>
  conversationUnreadProjection({ ownerId, binding, name: 'main', chats, ...patch });

describe('host conversation unread projection', () => {
  it('refuses raw chat IDs or an undeclared alias in an unread source', () => {
    const manifest = { id: 'reader', name: 'Reader', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', platforms: ['desktop'], entry: 'index.html', permissions: { capabilities: ['chat:unread'], bindings: [{ name: 'main', kind: 'conversation', actions: ['unread'] }] }, contributes: { tabs: [{ name: 'main', title: 'Reader' }], unreadSource: { binding: 'main' } } };
    expect(() => parseExtensionManifest(manifest)).not.toThrow();
    for (const unreadSource of [{ binding: 'other' }, { binding: 'main', chatId: 'arbitrary' }]) {
      expect(() => parseExtensionManifest({ ...manifest, contributes: { ...manifest.contributes, unreadSource } })).toThrow();
    }
  });
  it('works with no live App page at cold start or after eviction, and follows the original count without mutating it', () => {
    const source = [{ id: 'selected-chat', unread_count: 2 }];
    expect(project(source)).toBe(true);
    expect(project(source)).toBe(true);
    expect(source).toEqual([{ id: 'selected-chat', unread_count: 2 }]);
    source[0]!.unread_count = 0;
    expect(project(source)).toBe(false);
  });
  it('never borrows unread state from another conversation', () => {
    expect(project([{ id: 'other-chat', unread_count: 9 }, { id: 'selected-chat', unread_count: 0 }])).toBe(false);
  });
  it('does not turn missing authority, account changes, absent data or invalid counts into read confirmation', () => {
    expect(project([], { binding: null })).toBeNull();
    expect(project([], { ownerId: 'owner-b' })).toBeNull();
    expect(project([], { name: 'other' })).toBeNull();
    expect(project([])).toBeNull();
    expect(project([{ id: 'selected-chat', unread_count: Number.NaN }])).toBeNull();
    expect(project([{ id: 'selected-chat', unread_count: -1 }])).toBeNull();
  });
  it('opening and switching App pages cannot clear unread: only a change of the original source can', () => {
    const source = [{ id: 'selected-chat', unread_count: 1 }];
    for (const _event of ['open', 'page-switch', 'page-closed', 'evicted', 'restart']) expect(project(source)).toBe(true);
  });
});
