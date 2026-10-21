import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 论坛 (9) on the desktop bridge: what moves community points, and assigning an agent, go to the window as the host's own
 * sheet (`forumConsent`) and the page hears `{ confirming: true }` — never done straight from the page's call. A post without
 * a bounty goes up at once. Subscriptions are the page's and go with it.
 */

const PAGE = 7;
const POST = '0b000000-0000-4000-8000-000000000002';
const delivered: unknown[] = [];
const forum = {
  postPlain: vi.fn(async () => ({ post: POST })),
  bountyDraft: vi.fn((args: Record<string, unknown>) => ({ title: args.title, body: args.body, amount: 30, days: 3, visibility: 'public' })),
  awardDraft: vi.fn(async () => ({ post: POST, title: '并发问题', awards: [] })),
  assignDraft: vi.fn(async (_post: unknown, agent: unknown) => ({ post: POST, title: '并发问题', preselect: agent ?? null })),
  watch: vi.fn((_target: unknown, _fn: unknown) => stop),
};
const stop = vi.fn();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: {
    fromId: (id: number) =>
      id === 7 ? { id, isDestroyed: () => false, hostWebContents: { id: 42 }, session: {}, once: () => undefined, on: () => undefined, send: () => undefined } : undefined,
  },
}));
vi.mock('@main/core/extensions/extension-session', () => ({ extensionIdForSession: () => 'forum', isExtensionSessionConfigured: () => true }));
vi.mock('@main/core/extensions/extension-background', () => ({ extensionBackgroundWebContentsId: () => null }));
vi.mock('@main/core/extensions/extensions-root', () => ({
  extensionsService: () => ({ grantedCapabilities: () => [], hasCapability: () => true, get: () => ({ manifest: { name: '论坛' } }) }),
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/core/extensions/extension-send', () => ({ forumForApp: forum }));

const { answerCall, bindExtensionSurface, extensionSurfaceBindingForTests, setExtensionBridgeHost, stopPageWatches } = await import('./extension-bridge');

const page = () => {
  const binding = extensionSurfaceBindingForTests(PAGE)!;
  return { extensionId: 'forum', kind: 'page' as const, binding, pageId: PAGE, filePage: () => ({}) as never, hear: () => undefined };
};

beforeEach(async () => {
  delivered.length = 0;
  vi.clearAllMocks();
  setExtensionBridgeHost({
    deliver: (_hostId: number, action: unknown) => { delivered.push(action); return Promise.resolve(); },
    presentation: () => ({ locale: 'zh', themeMode: 'light' as const, fullscreen: true, windowFocused: true }),
  } as never);
  await bindExtensionSurface({ webContentsId: PAGE, extensionId: 'forum', tabId: 'slot-1', tabKind: 'forum.forum' });
});

describe('gugu.forum on the desktop', () => {
  it('a bounty post goes to the window\'s sheet; the page hears confirming', async () => {
    expect(await answerCall(page(), 'forumPost', { title: 't', body: 'b', bounty: { amount: 30, days: 3, visibility: 'public' } }))
      .toMatchObject({ ok: true, value: { confirming: true } });
    expect(delivered).toEqual([{ kind: 'forumConsent', detail: { type: 'bounty', draft: expect.objectContaining({ title: 't', amount: 30 }) } }]);
    expect(forum.postPlain).not.toHaveBeenCalled();
  });

  it('control: a post without a bounty goes up at once, no sheet', async () => {
    expect(await answerCall(page(), 'forumPost', { title: 't', body: 'b' })).toMatchObject({ ok: true, value: { post: POST } });
    expect(delivered).toEqual([]);
  });

  it('settling and assigning are the window\'s sheet too; an agentId only preselects', async () => {
    expect(await answerCall(page(), 'forumAward', { postId: POST, awards: [] })).toMatchObject({ ok: true, value: { confirming: true } });
    expect(await answerCall(page(), 'forumAssign', { postId: POST, agentId: 'user:0a000000-0000-4000-8000-000000000001' }))
      .toMatchObject({ ok: true, value: { confirming: true } });
    expect(delivered).toEqual([
      { kind: 'forumConsent', detail: { type: 'award', draft: { post: POST, title: '并发问题', awards: [] } } },
      { kind: 'forumConsent', detail: { type: 'assign', draft: { post: POST, title: '并发问题', preselect: 'user:0a000000-0000-4000-8000-000000000001' } } },
    ]);
  });

  it('a subscription is one per post per page, and goes with the page', async () => {
    await answerCall(page(), 'forumSubscribe', { target: POST });
    await answerCall(page(), 'forumSubscribe', { target: POST });
    expect(forum.watch).toHaveBeenCalledTimes(1);
    stopPageWatches(PAGE);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
