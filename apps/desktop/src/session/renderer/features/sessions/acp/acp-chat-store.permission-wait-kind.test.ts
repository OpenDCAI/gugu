// @vitest-environment jsdom
/**
 * A choose-one request (Hermes clarify, Pi's select: every option `allow_once`, none refusing) reaches the composer as a
 * question, so its options keep the provider's names; an approval or a plan review keeps the localized allow/reject labels
 * unless two of its options share a kind (a label must name exactly one option). The class comes from the runtime's own
 * `permissionWaitKind`, not a renderer copy of it.
 */
import { autorun, observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/acp/runtime-client', () => ({
  getAcpRuntimeClient: async () => ({}),
}));

// 桥必须在模块图加载之前就位 —— 理由见 acp-chat-store.session-absent.test.ts 抬头。
Object.defineProperty(document, 'fonts', {
  configurable: true,
  value: { load: vi.fn().mockResolvedValue([]) },
});
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    invoke: () => Promise.resolve([]),
    eventSend: () => {},
    eventOn: () => () => {},
    getPathForFile: () => '',
  },
});
const { AcpChatStore } = await import('./acp-chat-store');
const { toComposerPermission } = await import('./composer-permission');

describe('permission queue wait kinds', () => {
  it('reads a choose-one request as a question and an allow/reject request as an approval', () => {
    const store = new AcpChatStore('conv-wait-kind', 'proj-1');
    const option = (optionId: string, name: string, kind: string) => ({ optionId, name, kind });
    store.session = {
      sessionState: {
        current: () => ({
          lifecycle: 'working',
          activeTurnId: 'turn-1',
          queuedPrompts: [],
          pendingPermissions: [
            { requestId: 'clarify', toolCall: { title: 'Which colour?' }, options: [option('0', 'red', 'allow_once'), option('1', 'blue', 'allow_once')] },
            { requestId: 'terminal', toolCall: { title: 'rm -rf x' }, options: [option('once', 'Allow once', 'allow_once'), option('deny', 'Deny', 'reject_once')] },
          ],
        }),
      },
    } as never;
    expect(store.permissionQueue.map((item) => [item.requestId, item.waitKind])).toEqual([
      ['clarify', 'question'],
      ['terminal', 'approval'],
    ]);
  });
});

describe('permission band title', () => {
  it('names an MCP call as server · tool (toolCallLabel) — the tool a catalog_call runs, not catalog_call', () => {
    const store = new AcpChatStore('conv-band-title', 'proj-1');
    const toolCall = {
      kind: 'mcp-tool-call',
      title: 'mcp__plugin_gugu-product_gugu__catalog_call',
      server: 'plugin_gugu-product_gugu',
      tool: 'catalog_call',
      rawInput: JSON.stringify({ tool: 'dice__roll', args: {} }),
    };
    store.session = {
      sessionState: {
        current: () => ({ pendingPermissions: [{ requestId: 'r1', toolCall, options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] }] }),
      },
    } as never;
    expect(store.permissionQueue[0]?.title).toBe('plugin_gugu-product_gugu · dice__roll');
  });
});

describe('permission band labels', () => {
  const translate = (key: string) => `t:${key}`;
  const labels = (waitKind: 'question' | 'approval' | 'plan', options: Array<[string, string]>) =>
    toComposerPermission(
      { requestId: 'r', toolCallId: 'tc', title: 't', waitKind, options: options.map(([name, kind], i) => ({ optionId: String(i), name, kind })) },
      translate as never,
    )!.options.map((option) => option.label ?? option.name);

  it('a question shows the provider names', () => {
    expect(labels('question', [['red', 'allow_once'], ['blue', 'allow_once']])).toEqual(['red', 'blue']);
  });

  it('an approval keeps localized labels unless two options share a kind', () => {
    expect(labels('approval', [['Allow once', 'allow_once'], ['Allow for this session', 'allow_always'], ['Always allow', 'allow_always'], ['Deny', 'reject_once']]))
      .toEqual(['t:composer.allowOnce', 'Allow for this session', 'Always allow', 't:composer.rejectOnce']);
    expect(labels('approval', [['Yes', 'allow_once'], ['Always', 'allow_always'], ['No', 'reject_once']]))
      .toEqual(['t:composer.allowOnce', 't:composer.allowAlways', 't:composer.rejectOnce']);
  });

  // Claude ACP's plan review (claude-agent-acp 1.3.0 permissions/options/tools.js): three allow_always options. Read as a
  // plan they once all became "Always allow" — three buttons nobody can tell apart (mac1 desktop, 10-12).
  it('a plan review keeps the names of options that share a kind', () => {
    expect(labels('plan', [
      ['Yes, manually approve edits', 'allow_once'],
      ['Yes, clear context (1% used) and use auto mode', 'allow_always'],
      ['Yes, and use auto mode', 'allow_always'],
      ['Yes, and bypass permissions', 'allow_always'],
      ['No, keep planning', 'reject_once'],
    ])).toEqual([
      't:composer.allowOnce',
      'Yes, clear context (1% used) and use auto mode',
      'Yes, and use auto mode',
      'Yes, and bypass permissions',
      't:composer.rejectOnce',
    ]);
  });
});

// The plan card answers the same request in the transcript (#7139). The band steps aside only once that card is there: a
// request that lands before its tool row would otherwise leave nothing to answer it with. The session's live models are mobx
// stores (session-wire's createImmutableMobxStore) and the composer is a mobx observer — an autorun stands in for it.
describe('plan review band', () => {
  it('stays while the request is ahead of its tool row, and goes the moment the row lands', () => {
    const store = new AcpChatStore('conv-plan-band', 'proj-1');
    const toolCall = { kind: 'unknown-tool-call', id: 't1:tool:toolu_1', toolCallId: 'toolu_1', toolName: 'ExitPlanMode', title: 'Approve Plan', status: 'running' };
    const options = [{ optionId: 'exit-plan-default', name: 'Yes', kind: 'allow_once' }, { optionId: 'reject', name: 'No', kind: 'reject_once' }];
    const sessionState = observable.box<{ pendingPermissions: unknown[] }>({ pendingPermissions: [] }, { deep: false });
    const activeTurn = observable.box<unknown>({ id: 't1', seq: 1, initiator: 'user', items: [] }, { deep: false });
    store.session = {
      sessionState: { current: () => sessionState.get() },
      activeTurn: { current: () => activeTurn.get() },
    } as never;
    let band: string | null = null;
    const stop = autorun(() => {
      band = toComposerPermission(store.permissionQueue[0], (key) => key, (id) => store.hasActiveToolCall(id))?.requestId ?? null;
    });
    runInAction(() => sessionState.set({ pendingPermissions: [{ requestId: 'plan', toolCall, options }] }));
    expect(store.permissionQueue[0]?.waitKind).toBe('plan');
    expect(band).toBe('plan');
    // The row lands in the session's turn and, as connectSession does, in the chat view's transcript (a Solid store).
    runInAction(() => activeTurn.set({ id: 't1', seq: 1, initiator: 'user', items: [toolCall] }));
    store.chatState.transcript.activeTurn.set({ id: 't1', seq: 1, initiator: 'user', items: [toolCall] } as never);
    expect(band, 'the card is in the turn: the band must go without waiting for another change').toBeNull();
    stop();
  });
});
