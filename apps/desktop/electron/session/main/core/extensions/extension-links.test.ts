import { describe, expect, it, vi } from 'vitest';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import {
  buildExtensionLink,
  openExtensionLinkWith,
  parseExtensionLink,
  type ExtensionLinkDeps,
} from './extension-links';

vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));

/**
 * #6387 Links into extensions. A link names an installed extension and one of its own
 * tabs, carries data only that extension reads, opens where it names (真源原则 13: a session,
 * a chat, or the App's own page — never the session on screen) and — when it cannot open —
 * comes back with the reason, because the person who clicked it is waiting.
 */

const manifest = parseExtensionManifest({
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion: EXTENSION_API_VERSION,
  entry: 'main.html',
  contributes: { tabs: [{ name: 'main', title: 'Main' }, { name: 'inbox', title: 'Inbox' }] },
});

describe('building and reading links (#6387)', () => {
  it('round-trips tab, path and query, with this build\'s scheme', () => {
    const link = buildExtensionLink({
      scheme: 'gugu-beta', manifest, tab: 'inbox', path: 'papers/ä 1', query: { id: 42, open: true },
    });
    expect(link).toBe('gugu-beta://ext/notes/inbox/papers/%C3%A4%201?id=42&open=true');
    expect(parseExtensionLink(link, 'gugu-beta')).toEqual({
      extensionId: 'notes', tab: 'inbox', path: 'papers/ä 1', query: { id: '42', open: 'true' }, place: null,
    });
  });

  it('carries where it opens under gugu\'s own keys, kept out of the App\'s query', () => {
    const inSession = buildExtensionLink({ scheme: 'gugu', manifest, path: '', query: { x: 1 }, place: { session: 's1' } });
    expect(inSession).toBe('gugu://ext/notes/main?x=1&gugu.session=s1');
    expect(parseExtensionLink(inSession, 'gugu')).toMatchObject({ query: { x: '1' }, place: { session: 's1' } });
    expect(parseExtensionLink(buildExtensionLink({ scheme: 'gugu', manifest, path: '', query: {}, place: { chat: 'c1' } }), 'gugu'))
      .toMatchObject({ place: { chat: 'c1' } });
    expect(() => buildExtensionLink({ scheme: 'gugu', manifest, path: '', query: { 'gugu.chat': 'c2' } })).toThrow(/gugu's own/);
  });

  it('defaults to the first tab and refuses a tab the extension does not have', () => {
    expect(buildExtensionLink({ scheme: 'gugu', manifest, path: '', query: {} })).toBe('gugu://ext/notes/main');
    expect(() => buildExtensionLink({ scheme: 'gugu', manifest, tab: 'nope', path: '', query: {} })).toThrow(/no tab named/);
  });

  it('refuses paths that climb, nested query values, and links too long to be links', () => {
    expect(() => buildExtensionLink({ scheme: 'gugu', manifest, path: '../x', query: {} })).toThrow(/"\.\."/);
    expect(() => buildExtensionLink({ scheme: 'gugu', manifest, path: '', query: { a: { b: 1 } } })).toThrow(/must be a string/);
    expect(() => buildExtensionLink({ scheme: 'gugu', manifest, path: 'x'.repeat(3000), query: {} })).toThrow(/longer than/);
  });

  it('ignores anything that is not an extension link of this build', () => {
    expect(parseExtensionLink('gugu://ext/notes/main', 'gugu-beta')).toBeNull();
    expect(parseExtensionLink('gugu://chat/123', 'gugu')).toBeNull();
    expect(parseExtensionLink('gugu://ext/notes', 'gugu')).toBeNull();
    expect(parseExtensionLink('not a url', 'gugu')).toBeNull();
  });
});

function deps(overrides: Partial<ExtensionLinkDeps> = {}) {
  const delivered: { id: string; event: ExtensionHostEvent; opened: unknown }[] = [];
  const value: ExtensionLinkDeps = {
    scheme: 'gugu',
    installed: () => [{ manifest }],
    isEnabled: () => true,
    locale: () => 'en-US',
    sessionProject: async (sessionId) => (sessionId === 's1' ? 'p1' : null),
    reveal: vi.fn(async () => {}),
    openApp: vi.fn(async () => {}),
    deliver: (id, event, opened) => delivered.push({ id, event, opened }),
    ...overrides,
  };
  return { value, delivered };
}

describe('opening a link (#6387)', () => {
  it('a session named: its tab there, handed the rest of the link', async () => {
    const { value, delivered } = deps();
    await expect(openExtensionLinkWith(value, 'gugu://ext/notes/inbox/p/7?x=1&gugu.session=s1'))
      .resolves.toEqual({ kind: 'opened', extensionId: 'notes', tab: 'inbox' });
    expect(value.reveal).toHaveBeenCalledWith({ sessionId: 's1', projectId: 'p1', tabKind: 'notes.inbox' });
    expect(delivered).toEqual([{ id: 'notes', event: { type: 'link', tab: 'inbox', path: 'p/7', query: { x: '1' }, file: null }, opened: { session: 's1' } }]);
  });

  // Control (the parent commit a770f2e40d): every link opened in the session on screen, or failed `no-session` with none.
  it('a chat named: the App in its panel; neither: the App\'s own page', async () => {
    const chat = deps();
    await openExtensionLinkWith(chat.value, 'gugu://ext/notes/main?gugu.chat=c1');
    expect(chat.value.openApp).toHaveBeenCalledWith('notes', 'c1');
    expect(chat.delivered[0]!.opened).toEqual({ chat: 'c1' });
    const own = deps();
    await openExtensionLinkWith(own.value, 'gugu://ext/notes/main/x');
    expect(own.value.openApp).toHaveBeenCalledWith('notes', null);
    expect(own.value.reveal).not.toHaveBeenCalled();
    expect(own.delivered[0]!.opened).toBe('own');
  });

  it('leaves other gugu links alone', async () => {
    await expect(openExtensionLinkWith(deps().value, 'gugu://chat/1')).resolves.toEqual({ kind: 'not-extension-link' });
  });

  it('says why a link did nothing', async () => {
    const open = (overrides: Partial<ExtensionLinkDeps>, url = 'gugu://ext/notes/main?gugu.session=s1') =>
      openExtensionLinkWith(deps(overrides).value, url);
    await expect(open({}, 'gugu://ext/ghost/main')).resolves.toMatchObject({ kind: 'failed', reason: 'not-installed', name: 'ghost' });
    await expect(open({ isEnabled: () => false })).resolves.toMatchObject({ reason: 'disabled', name: 'Notes' });
    // 名字按界面语言取 manifest 的 localized。
    const zh = { installed: () => [{ manifest: { ...manifest, localized: { 'zh-CN': { name: '笔记' } } } }], locale: () => 'zh-CN' };
    await expect(open({ ...zh, isEnabled: () => false })).resolves.toMatchObject({ reason: 'disabled', name: '笔记' });
    await expect(open({}, 'gugu://ext/notes/gone')).resolves.toMatchObject({ reason: 'no-such-tab', detail: 'gone' });
    await expect(open({}, 'gugu://ext/notes/main?gugu.session=elsewhere')).resolves.toMatchObject({ reason: 'no-session' });
    await expect(open({ reveal: async () => { throw new Error('pane busy'); } }))
      .resolves.toMatchObject({ reason: 'open-failed', detail: 'pane busy' });
  });
});
