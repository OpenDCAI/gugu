import { sessionWorkspace } from '@shared/extensions/app-runtime-protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who gets told an agent moved, and about which agents.
 *
 * The event is ids-only and rides on `agents:read`, so the two ways it goes
 * wrong are both invisible in normal use: telling a surface that never asked,
 * and telling a `task`-scoped surface about an agent in someone else's task.
 * Both are judged here against a visibility set that deliberately contains an
 * agent the surface must NOT hear about. Refs #4068.
 */

const sentEvents: unknown[] = [];
/** Events for the other two pages — a group's side panel (8) and the background page (9) — by page. */
const otherEvents = new Map<number, unknown[]>();
const contentsOf = (id: number) => ({
  id,
  isDestroyed: () => false,
  hostWebContents: { id: 42 },
  session: {},
  once: () => undefined,
  on: () => undefined,
  send: (_channel: string, payload: unknown) => {
    if (id === 7) sentEvents.push(payload);
    else otherEvents.set(id, [...(otherEvents.get(id) ?? []), payload]);
  },
});
const fakeContents = contentsOf(7);

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: (id: number) => (id === 7 ? fakeContents : id === 8 || id === 9 ? contentsOf(id) : undefined) },
}));

vi.mock('@main/core/extensions/extension-session', () => ({
  extensionIdForSession: () => 'ext.notes',
}));

/** The backgrounds running now; none unless a case starts one. */
let backgrounds: [string, number][] = [];
vi.mock('@main/core/extensions/extension-background', () => ({
  extensionBackgroundWebContentsId: () => null,
  runningExtensionBackgrounds: () => backgrounds,
}));

let granted: string[] = [];
// 宽窄的判法用真的(manifest.ts 那两个纯函数),只把「授了哪些词」换成假的。
vi.mock('@main/core/extensions/extensions-root', async () => {
  const { capabilityCovered, grantedReach } = await import('@shared/extensions/manifest');
  return {
    extensionsService: () => ({
      grantedCapabilities: () => granted,
      hasCapability: (_id: string, wanted: string) => capabilityCovered(granted, wanted),
      agentReach: (_id: string, family: string) => grantedReach(granted, family),
    }),
  };
});

const warn = vi.fn();
vi.mock('@main/core/extensions/app-files', () => ({ resourceChatOf: async (id: string) => id }));
vi.mock('@main/lib/logger', () => ({ log: { warn: (...a: unknown[]) => warn(...a), error: vi.fn(), info: vi.fn() } }));

/**
 * The scope filter, standing in for the real conversation read.
 *
 * `own` (the agents the App started) deliberately excludes `other-task-agent` — without an id the surface
 * must not hear about, "filtered by scope" is a claim nothing can falsify.
 * The host reports sessions; an App hears of them by the id it names agents with (F35): here `user:<session>`.
 */
const named = (...sessions: string[]) => new Map(sessions.map((session): [string, string] => [`user:${session}`, session]));
const visibleAgentsForExtension = vi.fn(async (options: { scope: 'own' | 'all' }) =>
  options.scope === 'all' ? named('agent-1', 'agent-2', 'other-task-agent') : named('agent-1', 'agent-2'),
);
vi.mock('@main/core/extensions/extension-agents', () => ({
  visibleAgentsForExtension: (options: { scope: 'own' | 'all' }) => visibleAgentsForExtension(options),
}));

const { bindExtensionSurface, setExtensionBridgeHost, notifyExtensionAgentsChanged } = await import(
  './extension-bridge'
);


/** Lets the coalescing window elapse and the lazy import + async filter settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(60);
  await vi.runAllTimersAsync();
}

function agentEvents(): string[][] {
  return sentEvents
    .filter((e): e is { type: string; agentIds: string[] } =>
      Boolean(e && typeof e === 'object' && (e as { type?: string }).type === 'agentsChanged')
    )
    .map((e) => e.agentIds);
}

function agentEventsOf(id: number): string[][] {
  return (otherEvents.get(id) ?? [])
    .filter((e): e is { type: string; agentIds: string[] } =>
      Boolean(e && typeof e === 'object' && (e as { type?: string }).type === 'agentsChanged')
    )
    .map((e) => e.agentIds);
}

beforeEach(async () => {
  vi.useFakeTimers();
  sentEvents.length = 0;
  otherEvents.clear();
  backgrounds = [];
  warn.mockReset();
  visibleAgentsForExtension.mockClear();
  granted = ['agents:read'];
  setExtensionBridgeHost({
    deliver: () => Promise.resolve(),
    presentation: () => ({
      locale: 'en',
      themeMode: 'dark' as const,
      fullscreen: false,
      windowFocused: true,
    }),
  });
  await bindExtensionSurface({
    webContentsId: fakeContents.id,
    extensionId: 'ext.notes',
    workspace: sessionWorkspace('task-1'),
    tabId: 'tab-1',
    tabKind: 'ext.notes.main',
  });
  sentEvents.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('agent 动了要有人说一声', () => {
  it('看得见的 agent 变了,推一条只带 id 的通知', async () => {
    notifyExtensionAgentsChanged('agent-1');
    await settle();
    expect(agentEvents()).toEqual([['user:agent-1']]);
  });

  it('一串变化合成一条,❌ 不是一次一条', async () => {
    notifyExtensionAgentsChanged('agent-1');
    notifyExtensionAgentsChanged('agent-2');
    notifyExtensionAgentsChanged('agent-1');
    await settle();
    expect(agentEvents()).toEqual([['user:agent-1', 'user:agent-2']]);
  });
});

describe('没申报就收不到,申报多宽收多宽', () => {
  it('没有 agents:read 的 surface 根本不订阅', async () => {
    granted = ['files:read'];
    notifyExtensionAgentsChanged('agent-1');
    await settle();
    expect(agentEvents()).toEqual([]);
  });

  it('只有 agents:read 时,不是自己起的 agent 听不到', async () => {
    notifyExtensionAgentsChanged('other-task-agent');
    await settle();
    expect(agentEvents()).toEqual([]);
  });

  it('声明了 agents:read:all,同一条 id 就听得到了', async () => {
    granted = ['agents:read:all'];
    notifyExtensionAgentsChanged('other-task-agent');
    await settle();
    expect(agentEvents()).toEqual([['user:other-task-agent']]);
    expect(visibleAgentsForExtension).toHaveBeenCalledWith({ scope: 'all', extensionId: 'ext.notes' });
  });
});

// 页面开在哪不参与(真源原则 13):群侧栏的页、后台页、会话里的 tab 听到的是同一批。对照(父提交 a770f2e40d):会话里的 tab
// 还听得到它那条会话的 agent,群侧栏和后台页只听得到自己起的。
describe('每一页听到的都一样:这个 App 够得着的 agent(F13;L12 后台页)', () => {
  it('群侧栏的页和会话里的 tab:同一批,一次算一遍', async () => {
    await bindExtensionSurface({ webContentsId: 8, extensionId: 'ext.notes', tabId: 'panel', tabKind: 'ext.notes.main', conversation: 'chat-1' });
    notifyExtensionAgentsChanged('agent-1');
    notifyExtensionAgentsChanged('other-task-agent');
    await settle();
    expect(agentEventsOf(8)).toEqual([['user:agent-1']]);
    expect(agentEvents()).toEqual([['user:agent-1']]);
    expect(visibleAgentsForExtension).toHaveBeenCalledTimes(1);
  });

  it('后台页:同样;:all 就是全部', async () => {
    backgrounds = [['ext.notes', 9]];
    notifyExtensionAgentsChanged('agent-1');
    notifyExtensionAgentsChanged('other-task-agent');
    await settle();
    expect(agentEventsOf(9)).toEqual([['user:agent-1']]);
    expect(visibleAgentsForExtension).toHaveBeenCalledWith({ scope: 'own', extensionId: 'ext.notes' });
    granted = ['agents:read:all'];
    notifyExtensionAgentsChanged('other-task-agent');
    await settle();
    expect(agentEventsOf(9)).toEqual([['user:agent-1'], ['user:other-task-agent']]);
  });

  it('对照:没有 agents:read 的后台页什么都听不到', async () => {
    granted = ['notifications'];
    backgrounds = [['ext.notes', 9]];
    notifyExtensionAgentsChanged('agent-1');
    await settle();
    expect(agentEventsOf(9)).toEqual([]);
  });
});

describe('过滤器自己坏掉时,不许假装无事发生', () => {
  it('算不出可见集合就告警,❌ 不静默吞掉', async () => {
    visibleAgentsForExtension.mockRejectedValueOnce(new Error('db is gone'));
    notifyExtensionAgentsChanged('agent-1');
    await settle();
    expect(agentEvents()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('agent-change'),
      expect.objectContaining({ error: 'db is gone' })
    );
  });
});
