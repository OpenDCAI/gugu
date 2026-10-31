import { describe, expect, it, vi } from 'vitest';
import type { ExtensionHostEvent } from '@shared/extensions/bridge-protocol';
import { EXTENSION_API_VERSION, parseExtensionManifest } from '@shared/extensions/manifest';
import { linkTargetOf, conversationLink, groupFileLink, guguLink, parseGuguLink } from '@gugu/core/shared/ui/guguLink';
import { openLinkWith, type LinkOpenDeps } from '@shared/extensions/open-link';

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

const appLink = (args: Record<string, unknown>, scheme = 'gugu') => guguLink(linkTargetOf(args, manifest), scheme);

describe('building and reading links (#6387)', () => {
  it('round-trips tab, path and query, with this build\'s scheme', () => {
    const link = appLink({ tab: 'inbox', path: 'papers/ä 1', query: { id: 42, open: true } }, 'gugu-beta');
    expect(link).toBe('gugu-beta://ext/notes/inbox/papers/%C3%A4%201?id=42&open=true');
    expect(parseGuguLink(link)).toEqual({
      kind: 'app', extensionId: 'notes', tab: 'inbox', path: 'papers/ä 1', query: { id: '42', open: 'true' }, place: null,
    });
  });

  it('carries where it opens under gugu\'s own keys, kept out of the App\'s query', () => {
    const inSession = appLink({ path: '', query: { x: 1 }, session: 's1' });
    expect(inSession).toBe('gugu://ext/notes/main?x=1&gugu.session=s1');
    expect(parseGuguLink(inSession)).toMatchObject({ query: { x: '1' }, place: { session: 's1' } });
    expect(parseGuguLink(appLink({ path: '', query: {}, chat: 'c1' })))
      .toMatchObject({ place: { chat: 'c1' } });
    expect(() => appLink({ path: '', query: { 'gugu.chat': 'c2' } })).toThrow(/gugu's own/);
  });

  it('defaults to the first tab and refuses a tab the extension does not have', () => {
    expect(appLink({ path: '', query: {} })).toBe('gugu://ext/notes/main');
    expect(() => appLink({ tab: 'nope', path: '', query: {} })).toThrow(/no tab named/);
  });

  it('refuses paths that climb, nested query values, and links too long to be links', () => {
    expect(() => appLink({ path: '../x', query: {} })).toThrow(/"\.\."/);
    expect(() => appLink({ path: '', query: { a: { b: 1 } } })).toThrow(/must be a string/);
    expect(() => appLink({ path: 'x'.repeat(3000), query: {} })).toThrow(/longer than/);
  });

  it('rejects malformed resources and non-gugu schemes', () => {
    expect(parseGuguLink('https://ext/notes/main')).toBeNull();
    expect(parseGuguLink('gugu://chat/123')).toBeNull();
    expect(parseGuguLink('gugu://ext/notes')).toBeNull();
    expect(parseGuguLink('not a url')).toBeNull();
  });
});

function deps(overrides: Partial<LinkOpenDeps> = {}) {
  const delivered: { id: string; event: ExtensionHostEvent; opened: unknown }[] = [];
  const value: LinkOpenDeps = {
    installed: () => [{ manifest }],
    isEnabled: () => true,
    locale: () => 'en-US',
    sessionProject: async (sessionId) => (sessionId === 's1' ? 'p1' : null),
    agentSession: async (agentId) => (agentId === 'agent-1' ? { sessionId: 's1' } : null),
    reveal: vi.fn(async () => {}),
    openApp: vi.fn(async (_id, _tab, chat) => chat ? { chat } : 'own'),
    resourceChat: async (id) => id,
    openResource: vi.fn(async () => {}),
    bringUp: vi.fn(async () => {}),
    deliver: (id, event, opened) => delivered.push({ id, event, opened }),
    ...overrides,
  };
  return { value, delivered };
}

describe('opening a link (#6387)', () => {
  it('a session named: its tab there, handed the rest of the link', async () => {
    const { value, delivered } = deps();
    await expect(openLinkWith(value, 'gugu://ext/notes/inbox/p/7?x=1&gugu.session=s1'))
      .resolves.toMatchObject({ kind: 'opened', target: { kind: 'app', extensionId: 'notes', tab: 'inbox' } });
    expect(value.reveal).toHaveBeenCalledWith({ sessionId: 's1', projectId: 'p1', tabKind: 'notes.inbox' });
    expect(delivered).toEqual([{ id: 'notes', event: { type: 'link', tab: 'inbox', path: 'p/7', query: { x: '1' }, file: null }, opened: { session: 's1' } }]);
  });

  // Control (the parent commit a770f2e40d): every link opened in the session on screen, or failed `no-session` with none.
  it('a chat named: the App in its panel; neither: the App\'s own page', async () => {
    const chat = deps();
    await openLinkWith(chat.value, 'gugu://ext/notes/main?gugu.chat=c1');
    expect(chat.value.openApp).toHaveBeenCalledWith('notes', 'main', 'c1');
    expect(chat.delivered[0]!.opened).toEqual({ chat: 'c1' });
    const own = deps();
    await openLinkWith(own.value, 'gugu://ext/notes/main/x');
    expect(own.value.openApp).toHaveBeenCalledWith('notes', 'main', null);
    expect(own.value.reveal).not.toHaveBeenCalled();
    expect(own.delivered[0]!.opened).toBe('own');
  });

  it('leaves other gugu links alone', async () => {
    await expect(openLinkWith(deps().value, 'gugu://chat/1')).resolves.toEqual({ kind: 'not-gugu-link' });
  });

  it('says why a link did nothing', async () => {
    const open = (overrides: Partial<LinkOpenDeps>, url = 'gugu://ext/notes/main?gugu.session=s1') =>
      openLinkWith(deps(overrides).value, url);
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

const CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MESSAGE = '11111111-2222-4333-8444-555555555555';

describe('resource links share one parser and opener', () => {
  it('keeps stored references independent of the build and reads external invocation as the same target', async () => {
    const targets = [
      { kind: 'chat' as const, chatId: CHAT, messageId: MESSAGE },
      { kind: 'file' as const, itemId: CHAT, version: 7, at: { range: 'R&D!A1', slide: '3' } },
    ];
    for (const target of targets) {
      const stored = guguLink(target);
      expect(stored).toBe(target.kind === 'chat' ? conversationLink(CHAT, MESSAGE) : groupFileLink(CHAT, target));
      expect(stored).not.toContain('beta');
      const value = deps().value;
      for (const url of [stored, guguLink(target, 'gugu-beta'), guguLink(target, 'gugu-dev')]) {
        expect(parseGuguLink(url)).toEqual(target);
        await expect(openLinkWith(value, url)).resolves.toEqual({ kind: 'opened', target });
      }
      expect(value.openResource).toHaveBeenCalledTimes(3);
      expect(value.openApp).not.toHaveBeenCalled();
    }
  });

  it('hands session and project targets to the existing resource navigation without opening a browser', async () => {
    const value = deps().value;
    for (const target of [{ kind: 'session' as const, sessionId: 's1' }, { kind: 'project' as const, projectId: 'p1' }]) {
      await openLinkWith(value, guguLink(target, 'gugu-beta'));
      expect(value.openResource).toHaveBeenCalledWith(target);
    }
  });

  it('a session the window does not open (only the assistant\'s own task opens there) comes up from the host\'s task list', async () => {
    // Control (the parent commit 2dae2795): the window's phone-only directory was the end of it, so on a desktop a session
    // link, clicked in a chat or handed over by the OS, failed for any session but the assistant's.
    const desktop = deps().value;
    await expect(openLinkWith(desktop, 'gugu://session/s1')).resolves.toMatchObject({ kind: 'opened' });
    expect(desktop.bringUp).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1' });
    const assistant = deps({ openResource: vi.fn(async () => 'own' as const) }).value;
    await openLinkWith(assistant, 'gugu://session/s1');
    expect(assistant.bringUp).not.toHaveBeenCalled();
    const nowhere = deps().value;
    await expect(openLinkWith(nowhere, 'gugu://session/elsewhere')).resolves.toMatchObject({ kind: 'failed', reason: 'no-session' });
    expect(nowhere.bringUp).not.toHaveBeenCalled();
  });

  it('an agent named instead of its session opens that session the same way; an agent with none is said, nothing opened', async () => {
    const value = deps().value;
    await expect(openLinkWith(value, { kind: 'session', agentId: 'agent-1' })).resolves.toMatchObject({ kind: 'opened', target: { kind: 'session', sessionId: 's1' } });
    expect(value.openResource).toHaveBeenCalledWith({ kind: 'session', sessionId: 's1' });
    expect(value.bringUp).toHaveBeenCalledWith({ projectId: 'p1', sessionId: 's1' });
    const none = deps().value;
    await expect(openLinkWith(none, { kind: 'session', agentId: 'agent-x' })).resolves.toMatchObject({ kind: 'failed', reason: 'no-session' });
    expect(none.bringUp).not.toHaveBeenCalled();
  });

  it('hands what the opener knew (machine, project) to the task list, and a task card\'s beside to the bring-up', async () => {
    const value = deps({ sessionProject: vi.fn(async () => 'p-far') }).value;
    await openLinkWith(value, { kind: 'session', sessionId: 's-far', deviceId: 'dev-b', projectId: 'p-far', beside: true });
    expect(value.sessionProject).toHaveBeenCalledWith('s-far', { deviceId: 'dev-b', projectId: 'p-far' });
    expect(value.bringUp).toHaveBeenCalledWith({ projectId: 'p-far', sessionId: 's-far', beside: true });
  });

  it('delivers to the actual place the App opened, including an App already placed in a task', async () => {
    const { value, delivered } = deps({ openApp: vi.fn(async () => ({ session: 'already-there' })) });
    await openLinkWith(value, 'gugu://ext/notes/inbox/paper/7');
    expect(value.openApp).toHaveBeenCalledWith('notes', 'inbox', null);
    expect(delivered).toEqual([{ id: 'notes', event: { type: 'link', tab: 'inbox', path: 'paper/7', query: {}, file: null }, opened: { session: 'already-there' } }]);
  });

  it('normalizes an App resource chat once and uses that exact place for opening and delivery', async () => {
    const resolve = vi.fn(async () => 'source-group');
    const { value, delivered } = deps({ resourceChat: resolve });
    await openLinkWith(value, 'gugu://ext/notes/inbox?gugu.chat=topic');
    expect(resolve).toHaveBeenCalledOnce();
    expect(value.openApp).toHaveBeenCalledWith('notes', 'inbox', 'source-group');
    expect(delivered[0]!.opened).toEqual({ chat: 'source-group' });
  });

  it('returns the existing visible failure when resource navigation fails', async () => {
    await expect(openLinkWith(deps({ openResource: async () => { throw new Error('not in this chat'); } }).value, conversationLink(CHAT)))
      .resolves.toMatchObject({ kind: 'failed', reason: 'open-failed', detail: 'not in this chat' });
  });
});
