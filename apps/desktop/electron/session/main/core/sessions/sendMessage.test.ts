import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@shared/core/sessions/session-config';
import { awaitPending } from '../../../../../../../tests/support/awaitFact';
import { sessionDeliveryFailedChannel } from '@shared/core/sessions/sessionEvents';

const state = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  receipts: [] as Array<Record<string, unknown>>,
  failNextConfigUpdate: false,
  accept: vi.fn(),
  sessionAvailable: true,
  messageTransport: 'local-session' as 'local-session' | 'router' | 'none',
  emit: vi.fn(),
  /** 等「落库之后的某个状态」的用例;假库每写一次就重判一次(见 whenPersisted)。 */
  waiters: new Set<{ holds: () => boolean; resolve: () => void }>(),
  written(): void {
    for (const waiter of this.waiters) {
      if (!waiter.holds()) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  },
}));

vi.mock('@gugu/session-plugins/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gugu/session-plugins/agents')>();
  return {
    ...actual,
    resolveSessionpageSessionIntegration: (providerId: string, surface: 'acp' | 'tui') => {
      const integration = actual.resolveSessionpageSessionIntegration(providerId, surface);
      return { ...integration, messageTransport: state.messageTransport };
    },
  };
});

vi.mock('@main/core/projects/utils', () => ({
  resolveSession: () => state.sessionAvailable
    ? { sessions: { sendMessage: state.accept } }
    : null,
}));

vi.mock('@main/db/client', () => ({
  db: (() => {
    const mockDb = {
      select: (projection?: unknown) => ({
        from: () => ({
          where: () => ({
            limit: () => ({
              all: () => projection
                ? 'config' in (projection as Record<string, unknown>)
                  ? [structuredClone(state.row)]
                  : structuredClone(state.receipts)
                : [state.row],
            }),
          }),
          all: () => projection && 'config' in (projection as Record<string, unknown>)
            ? [structuredClone(state.row)]
            : projection
              ? structuredClone(state.receipts)
              : [state.row],
        }),
      }),
      update: () => ({
        set: (value: { config?: SessionConfig; metadata?: string }) => ({
          where: () => ({
            run: () => {
              if (value.config && state.failNextConfigUpdate) {
                state.failNextConfigUpdate = false;
                throw new Error('forced config update failure');
              }
              if (value.config) state.row.config = structuredClone(value.config);
              if (value.metadata) {
                const parsed = JSON.parse(value.metadata) as { state: string };
                // 状态图：queued ↔ dispatching，accepted 从 dispatching 来。
                // （`outcome-unknown` 不在这张图上：它只由启动认领写，代表进程没等到回执就没了。）
                const sourceState = parsed.state === 'dispatching'
                  ? 'queued'
                  : parsed.state === 'queued'
                    ? 'dispatching'
                    : 'dispatching';
                const receipt = state.receipts.find((candidate) => {
                  if (typeof candidate.metadata !== 'string') return false;
                  return (JSON.parse(candidate.metadata) as { state?: string }).state === sourceState;
                });
                if (receipt) receipt.metadata = value.metadata;
              }
              state.written();
            },
          }),
        }),
      }),
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          run: () => {
            state.receipts.push(structuredClone(value));
            state.written();
          },
        }),
      }),
      transaction: (action: (tx: unknown) => unknown) => {
        const rowBefore = structuredClone(state.row);
        const receiptsBefore = structuredClone(state.receipts);
        try {
          return action(mockDb);
        } catch (error) {
          state.row = rowBefore;
          state.receipts = receiptsBefore;
          throw error;
        }
      },
    };
    return mockDb;
  })(),
}));

vi.mock('./migrate-lifecycle-outbox', () => ({ migrateStrandedLifecycleOutbox: () => 0 }));
vi.mock('@main/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: state.emit },
}));

vi.mock('./utils', () => ({
  mapSessionRowToSession: (row: Record<string, unknown>) => ({
    id: row.id,
    projectId: row.projectId,
    providerId: row.provider,
    type: row.type,
  }),
}));

const {
  drainSessionMessageOutbox,
  drainSessionMessageOutboxById,
  sendMessage,
} = await import('./sendMessage');
const { setSessionMessageRouter, setSessionMessageOutboxReady } = await import('./session-message-router');
const { injectSessionMessageWhenReady } = await import('./impl/keystroke-injection');

const target = {
  projectId: 'project-1',
  sessionId: 'conversation-1',
};

/**
 * 发送之后的投递在后台跑(sendMessage 只等入队):等它把某个状态写进库。假库每写一次就重判 `assertion`,
 * 成立即 resolve(此刻已成立就立刻 resolve)—— 等的是写入这件事,❌ 按间隔轮询、❌ 墙钟上限。
 * 永远等不到时每 60 s 报一行点名 `step`。
 */
function whenPersisted(step: string, assertion: () => void): Promise<void> {
  const holds = (): boolean => {
    try {
      assertion();
      return true;
    } catch {
      return false;
    }
  };
  return awaitPending(step, new Promise<void>((resolve) => {
    if (holds()) resolve();
    else state.waiters.add({ holds, resolve });
  }));
}

function setRow(config: SessionConfig): void {
  state.row = {
    id: target.sessionId,
    projectId: target.projectId,
    provider: 'codex',
    type: 'pty',
    config: structuredClone(config),
  };
}

describe('conversation ordinary-message drain', () => {
  beforeEach(async () => {
    state.accept.mockReset();
    state.receipts = [];
    state.failNextConfigUpdate = false;
    state.messageTransport = 'local-session';
    state.sessionAvailable = true;
    state.emit.mockReset();
    state.waiters.clear();
    setSessionMessageRouter(null);
    await setSessionMessageOutboxReady(false);
    setRow({ version: '1', type: 'pty' });
  });

  it('passes the committed stable id into the adapter and persists its exact receipt', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-1', text: 'ordinary', state: 'pending' }],
    });
    state.accept.mockResolvedValue({ status: 'accepted', messageId: 'message-1' });

    await drainSessionMessageOutbox(target);

    expect(state.accept).toHaveBeenCalledWith(
      expect.objectContaining({ id: target.sessionId }),
      { id: 'message-1', text: 'ordinary' },
    );
    expect(state.row.config).toMatchObject({
      messageOutbox: [],
    });
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-1',
      sessionId: target.sessionId,
      content: 'ordinary',
      sender: 'user',
    }));
  });

  it('fails before dispatch when the transport is mutated back to none', async () => {
    state.messageTransport = 'none';

    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-no-transport',
      text: 'must not dispatch',
    })).rejects.toThrow('does not declare a session message transport');

    expect(state.receipts).toEqual([]);
  });

  it('delivers a task-TUI message through the real host injection adapter and records acceptance', async () => {
    state.messageTransport = 'local-session';
    const writes: string[] = [];
    const pty = {
      write: (data: string) => writes.push(data),
      resize: () => {},
      kill: () => {},
      onData: (handler: (data: string) => void) => { setTimeout(() => handler('ready'), 0); },
      onExit: () => {},
    };
    state.accept.mockImplementation(async (session: unknown, message: { id: string; text: string }) =>
      injectSessionMessageWhenReady({ pty, session: session as never, message })
    );

    await sendMessage({
      ...target,
      clientMessageId: 'message-real-tui-adapter',
      text: 'accepted by the host adapter',
    });
    await whenPersisted('the host adapter accepts the message', () => expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-real-tui-adapter',
      content: 'accepted by the host adapter',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'accepted' }),
    })));
    expect(writes.join('')).toContain('accepted by the host adapter');
  });

  it('settles a terminal with no prompt encoding as a visible delivery failure', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-no-encoding', text: 'first prompt', state: 'pending' }],
    });
    state.accept.mockRejectedValueOnce(new Error(
      'provider kimi declares no local message encoding — this terminal (task-TUI) session cannot receive injected messages',
    ));

    await drainSessionMessageOutbox(target);

    expect(state.row.config).toMatchObject({ messageOutbox: [] });
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-no-encoding',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'failed' }),
    }));
    expect(state.emit).toHaveBeenCalledWith(
      sessionDeliveryFailedChannel,
      expect.objectContaining({
        sessionId: target.sessionId,
        messageId: 'message-no-encoding',
      }),
    );
  });

  it('settles an enqueue-triggered drain rejection as a failed receipt and disclosure', async () => {
    setRow({ version: '1', type: 'pty' });
    state.accept.mockRejectedValueOnce(new Error('provider refused queued message'));

    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-drain-rejected',
      text: 'must become a visible failure',
    })).resolves.toEqual({ id: 'message-drain-rejected', status: 'queued' });

    await whenPersisted('the rejected drain settles as a failed receipt', () => expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-drain-rejected',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'failed' }),
    })));
    expect(state.row.config).toMatchObject({ messageOutbox: [] });
    expect(state.emit).toHaveBeenCalledWith(
      sessionDeliveryFailedChannel,
      expect.objectContaining({
        sessionId: target.sessionId,
        messageId: 'message-drain-rejected',
        message: 'provider refused queued message',
      }),
    );
  });

  it('persists the native turn receipt identity instead of fabricating provider acceptance', async () => {
    state.messageTransport = 'router';
    setSessionMessageRouter(async (_sessionId, message) => ({
      status: 'accepted',
      messageId: message.id,
      nativeReceiptId: 'turn-native-42',
    }));

    await sendMessage({
      ...target,
      clientMessageId: 'message-native-receipt',
      text: 'provider receipt boundary',
      kind: 'ordinary',
    });
    await whenPersisted('the native receipt is recorded', () => expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-native-receipt',
      metadata: JSON.stringify({
        kind: 'ordinary-message',
        state: 'accepted',
        nativeReceiptId: 'turn-native-42',
      }),
    })));
  });

  it('queues a message while offline and later drains it then a distinct message in order', async () => {
    state.messageTransport = 'router';
    const offline = vi.fn().mockResolvedValue({ status: 'not-ready' });
    setSessionMessageRouter(offline);

    await sendMessage({
      ...target,
      clientMessageId: 'message-offline',
      text: 'first work',
      kind: 'ordinary',
    });
    await whenPersisted('the offline router answers and the message is back to pending', () => {
      expect(offline).toHaveBeenCalled();
      expect((state.row.config as SessionConfig).messageOutbox?.[0]).toMatchObject({
        id: 'message-offline', kind: 'ordinary', state: 'pending',
      });
    });
    // Freeze the offline transport before enqueueing the follow-up so this assertion observes
    // durable queue state rather than a periodic retry racing through dispatching.
    setSessionMessageRouter(null);
    await sendMessage({
      ...target,
      clientMessageId: 'message-after-offline',
      text: 'follow-up work',
      kind: 'ordinary',
    });
    expect(state.row.config).toMatchObject({
      messageOutbox: [
        { id: 'message-offline', kind: 'ordinary', state: 'pending' },
        { id: 'message-after-offline', kind: 'ordinary', state: 'pending' },
      ],
    });

    const acceptedIds: string[] = [];
    setSessionMessageRouter(async (_sessionId, message) => {
      acceptedIds.push(message.id);
      return { status: 'accepted', messageId: message.id };
    });
    await drainSessionMessageOutbox(target);

    expect(acceptedIds).toEqual(['message-offline', 'message-after-offline']);
    expect(state.row.config).toMatchObject({ messageOutbox: [] });
  });

  it('drains an ACP message automatically when the ordinary router becomes ready', async () => {
    state.messageTransport = 'router';
    const offline = vi.fn().mockResolvedValue({ status: 'not-ready' });
    setSessionMessageRouter(offline);

    await sendMessage({
      ...target,
      clientMessageId: 'acp-ready-drain',
      text: 'persist until ACP is ready',
      kind: 'ordinary',
    });
    // The offline answer is only settled once the row is back to pending: opening the outbox reads pending rows,
    // and a row still marked dispatching is not one of them.
    await whenPersisted('the offline router answers and the message is back to pending', () => {
      expect(offline).toHaveBeenCalledOnce();
      expect(state.row.config).toMatchObject({ messageOutbox: [{ id: 'acp-ready-drain', state: 'pending' }] });
    });

    const ready = vi.fn(async (_sessionId: string, message: { id: string }) => ({
      status: 'accepted' as const,
      messageId: message.id,
    }));
    setSessionMessageRouter(ready);
    // Opening the outbox drains every pending conversation, queued behind the drain still in flight.
    await setSessionMessageOutboxReady();

    expect(ready).toHaveBeenCalledWith(
      target.sessionId,
      expect.objectContaining({ id: 'acp-ready-drain' }),
    );
    expect(state.row.config).toMatchObject({ messageOutbox: [] });
  });

  it('does not let a slow drain block later durable sends', async () => {
    state.messageTransport = 'router';
    const pendingRoutes: Array<(value: { status: 'accepted'; messageId: string }) => void> = [];
    const routed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const route = vi.fn((_sessionId: string, message: { id: string }) =>
      new Promise<{ status: 'accepted'; messageId: string }>((resolve) => {
        pendingRoutes.push((value) => resolve({ ...value, messageId: message.id }));
        routed[pendingRoutes.length - 1]?.resolve();
      }));
    setSessionMessageRouter(route);

    await expect(sendMessage({
      ...target,
      clientMessageId: 'slow-drain-head',
      text: 'first message',
      kind: 'ordinary',
    })).resolves.toMatchObject({ status: 'queued' });
    await routed[0]!.promise;
    expect(route).toHaveBeenCalledOnce();

    await expect(sendMessage({
      ...target,
      clientMessageId: 'send-behind-slow-drain',
      text: 'second message',
      kind: 'ordinary',
    })).resolves.toMatchObject({ status: 'queued' });

    pendingRoutes[0]!({ status: 'accepted', messageId: 'slow-drain-head' });
    await routed[1]!.promise;
    expect(route).toHaveBeenCalledTimes(2);
    pendingRoutes[1]!({ status: 'accepted', messageId: 'send-behind-slow-drain' });
    await whenPersisted('both messages leave the outbox', () => expect(state.row.config).toMatchObject({ messageOutbox: [] }));
  });

  it('drains a persisted ACP outbox when the router reopens after host restart', async () => {
    state.messageTransport = 'router';
    setRow({
      version: '1',
      type: 'acp',
      messageOutbox: [{
        id: 'acp-reopen-drain',
        text: 'survived host restart',
        kind: 'ordinary',
        state: 'pending',
      }],
    });
    const reopened = vi.fn(async (_sessionId: string, message: { id: string }) => ({
      status: 'accepted' as const,
      messageId: message.id,
    }));

    setSessionMessageRouter(reopened);
    await setSessionMessageOutboxReady();

    expect(reopened).toHaveBeenCalledWith(
      target.sessionId,
      expect.objectContaining({ id: 'acp-reopen-drain' }),
    );
    expect(state.row.config).toMatchObject({ messageOutbox: [] });
  });

  it('retries the same committed id after explicit rejection and restart', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-retry', text: 'retry me', state: 'pending' }],
    });
    state.accept.mockResolvedValueOnce({ status: 'not-ready' });
    await drainSessionMessageOutbox(target);
    expect(state.row.config).toMatchObject({
      messageOutbox: [{ id: 'message-retry', state: 'pending' }],
    });

    const restarted = structuredClone(state.row.config as SessionConfig);
    setRow(restarted);
    state.accept.mockResolvedValueOnce({ status: 'accepted', messageId: 'message-retry' });
    await drainSessionMessageOutbox(target);

    expect(state.accept).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      { id: 'message-retry', text: 'retry me' },
    );
    expect(state.row.config).toMatchObject({
      messageOutbox: [],
    });
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-retry',
      content: 'retry me',
    }));
  });

  it('restores pending when the local task runtime is not ready during boot', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'pty-early-boot', text: 'wait for task runtime', state: 'pending' }],
    });
    state.sessionAvailable = false;

    await drainSessionMessageOutbox(target);

    expect(state.row.config).toMatchObject({
      messageOutbox: [{ id: 'pty-early-boot', state: 'pending' }],
    });
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'pty-early-boot',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'queued' }),
    }));
  });

  it('fences an ambiguous adapter failure across restart and reports outcome unknown on retry', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-ambiguous', text: 'maybe accepted', state: 'pending' }],
    });
    state.accept.mockRejectedValueOnce(new Error('host response lost'));
    await expect(drainSessionMessageOutbox(target)).rejects.toThrow('host response lost');
    expect(state.row.config).toMatchObject({
      messageOutbox: [{ id: 'message-ambiguous', state: 'dispatching' }],
    });

    const restarted = structuredClone(state.row.config as SessionConfig);
    setRow(restarted);
    await drainSessionMessageOutbox(target);
    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-ambiguous',
      text: 'maybe accepted',
    })).resolves.toEqual({ id: 'message-ambiguous', status: 'outcome-unknown' });
  });

  it('认领者声明「受理前拒绝」的抛出落 failed 收据,不停在 dispatching(#4896 就绪预算到点)', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-rejected-pre-admission', text: 'never reached the provider', state: 'pending' }],
    });
    state.accept.mockRejectedValueOnce(Object.assign(
      new Error('claude 会话的 gugu MCP 在预算内没有就绪'),
      { deliveryRejectedBeforeAdmission: true },
    ));
    await expect(drainSessionMessageOutbox(target)).resolves.toBeUndefined();
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-rejected-pre-admission',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'failed' }),
    }));
    expect(state.row.config).not.toMatchObject({
      messageOutbox: [{ id: 'message-rejected-pre-admission', state: 'dispatching' }],
    });
  });

  it('provider 接受之前，UI 账本先落一行 dispatching（在途，不是结果未知）', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-crash-window', text: 'visible before provider', state: 'pending' }],
    });
    state.accept.mockImplementationOnce(async () => {
      expect(state.receipts).toContainEqual(expect.objectContaining({
        id: 'message-crash-window',
        sessionId: target.sessionId,
        content: 'visible before provider',
        sender: 'user',
        metadata: JSON.stringify({ kind: 'ordinary-message', state: 'dispatching' }),
      }));
      throw new Error('crash after provider accepted');
    });

    await expect(drainSessionMessageOutbox(target)).rejects.toThrow('crash after provider accepted');

    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-crash-window',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'dispatching' }),
    }));
  });

  it('drains a later pending message after restart without replaying the uncertain row', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [
        { id: 'message-uncertain', text: 'maybe accepted', state: 'dispatching' },
        { id: 'message-later', text: 'continue normally', state: 'pending' },
      ],
    });
    state.accept.mockResolvedValue({ status: 'accepted', messageId: 'message-later' });

    await drainSessionMessageOutbox(target);

    expect(state.accept).toHaveBeenCalledWith(
      expect.any(Object),
      { id: 'message-later', text: 'continue normally' },
    );
    expect(state.row.config).toMatchObject({
      messageOutbox: [
        { id: 'message-uncertain', text: 'maybe accepted', state: 'dispatching' },
      ],
    });
    expect(state.receipts).toContainEqual(expect.objectContaining({ id: 'message-later' }));
  });

  it('replays an internal receipt and rejects an internal id with different bytes', async () => {
    state.receipts = [{
      id: 'message-accepted',
      sessionId: target.sessionId,
      content: 'accepted text',
      sender: 'user',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'accepted' }),
    }];

    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-accepted',
      text: 'accepted text',
    })).resolves.toEqual({ id: 'message-accepted', status: 'accepted' });
    await expect(sendMessage({
      ...target,
      clientMessageId: 'message-accepted',
      text: 'different text',
    })).rejects.toThrow('conflicts with existing message bytes');
  });

  it('accepted 提交没做完时，账本上那行 dispatching 留着不动', async () => {
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'message-atomic', text: 'atomic receipt', state: 'pending' }],
    });
    state.accept.mockImplementationOnce(async () => {
      state.failNextConfigUpdate = true;
      return { status: 'accepted', messageId: 'message-atomic' };
    });

    await expect(drainSessionMessageOutbox(target))
      .rejects.toThrow('forced config update failure');

    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'message-atomic',
      metadata: JSON.stringify({ kind: 'ordinary-message', state: 'dispatching' }),
    }));
    expect(state.row.config).toMatchObject({
      messageOutbox: [{ id: 'message-atomic', text: 'atomic receipt', state: 'dispatching' }],
    });
  });
});

describe('session-direct live-only delivery', () => {
  beforeEach(() => {
    state.accept.mockReset();
    state.receipts = [];
    state.failNextConfigUpdate = false;
    state.messageTransport = 'router';
    state.sessionAvailable = true;
    state.emit.mockReset();
    state.waiters.clear();
    setSessionMessageRouter(null);
    setRow({ version: '1', type: 'acp' });
  });

  it('joins a concurrent replay of a session-direct message while the first router is still starting', async () => {
    const gate = Promise.withResolvers<void>();
    const router = vi.fn(async (_id: string, message: { id: string }) => { await gate.promise; return { status: 'accepted' as const, messageId: message.id }; });
    setSessionMessageRouter(router);
    const params = { ...target, clientMessageId: 'concurrent-replay', text: 'one original message', kind: 'session-direct' as const };
    const first = sendMessage(params);
    await vi.waitFor(() => expect(router).toHaveBeenCalledTimes(1));
    const second = sendMessage(params);
    try {
      await Promise.resolve(); await Promise.resolve();
      expect(router).toHaveBeenCalledTimes(1);
    } finally { gate.resolve(); await Promise.allSettled([first, second]); }
    expect(state.receipts.filter(row => row.id === params.clientMessageId)).toHaveLength(1);
  });
  it('does not begin a cancelled session-direct admission', async () => {
    const router = vi.fn(); setSessionMessageRouter(router);
    const controller = new AbortController(); controller.abort(new Error('delivery cancelled'));
    await expect(sendMessage({ ...target, clientMessageId: 'cancelled-before-start', text: 'no bytes', kind: 'session-direct', signal: controller.signal })).rejects.toThrow('delivery cancelled');
    expect(router).not.toHaveBeenCalled();
  });
  it('injects a live session synchronously and records only the recipient timeline row', async () => {
    const router = vi.fn(async (_sessionId: string, message: { id: string }) => ({
      status: 'accepted' as const,
      messageId: message.id,
    }));
    setSessionMessageRouter(router);
    await expect(sendMessage({
      ...target,
      clientMessageId: 'direct-1',
      text: 'hello there',
      kind: 'session-direct',
    })).resolves.toEqual({ id: 'direct-1', status: 'delivered' });
    expect(state.receipts).toContainEqual(expect.objectContaining({
      id: 'direct-1',
      sessionId: target.sessionId,
      metadata: JSON.stringify({ kind: 'session-direct', state: 'accepted' }),
    }));
    expect((state.row.config as SessionConfig).messageOutbox ?? []).toEqual([]);
  });

  it('returns a structured error for a non-live target without writing durable state', async () => {
    setSessionMessageRouter(vi.fn().mockResolvedValue({ status: 'not-ready' as const }));
    await expect(sendMessage({
      ...target,
      clientMessageId: 'direct-2',
      text: 'nobody home',
      kind: 'session-direct',
    })).rejects.toMatchObject({ code: 'SESSION_DIRECT_NOT_LIVE' });
    expect(state.receipts).toEqual([]);
    expect((state.row.config as SessionConfig).messageOutbox ?? []).toEqual([]);
  });

  it('keeps spawn startup delegation as the explicit durable exception', async () => {
    await expect(sendMessage({
      ...target,
      clientMessageId: 'delegation-1',
      text: 'go do the thing',
      kind: 'session-direct',
      queuedStartupDelegation: true,
    })).resolves.toEqual({ id: 'delegation-1', status: 'queued' });
    expect((state.row.config as SessionConfig).messageOutbox).toMatchObject([
      { id: 'delegation-1', state: 'pending', kind: 'session-direct' },
    ]);
  });

  // 宿主在「投递属主注册好了」那一刻手上**只有 conversationId**（provisioned 事件就带这一个），
  // 所以必须有一个按 id 排 outbox 的入口。没有它，排队的第一句 `ordinary` 就没人送 ——
  // codex 的全新会话正是死在这里：它的 startSession 要等首轮投递才返回，而原来负责投递的
  // drain 排在 startSession 之后，双方互等，90 秒超时。
  it('按会话 id 也能把排队的首轮排出去（宿主那一刻只有 conversationId）', async () => {
    state.messageTransport = 'local-session';
    setRow({
      version: '1',
      type: 'pty',
      messageOutbox: [{ id: 'first-turn', text: '说一句你好', state: 'pending' }],
    });
    state.accept.mockResolvedValue({ status: 'accepted', messageId: 'first-turn' });

    await drainSessionMessageOutboxById(target.sessionId);

    expect(state.accept, '按 id 那条通路没把首轮交给适配器 —— 会话会僵在启动态').toHaveBeenCalledWith(
      expect.objectContaining({ id: target.sessionId }),
      { id: 'first-turn', text: '说一句你好' },
    );
    expect((state.row.config as SessionConfig).messageOutbox).toEqual([]);
  });

  it('会话 id 查不到就响亮报错 —— ❌ 不静默当成「没活干」', async () => {
    state.row = undefined as unknown as typeof state.row;
    await expect(drainSessionMessageOutboxById('no-such-conversation')).rejects.toThrow(
      /not found for outbox drain/
    );
  });
});
